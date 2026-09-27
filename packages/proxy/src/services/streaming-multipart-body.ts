import { boundRequestBody, MAX_REQUEST_BODY_BYTES } from './bounded-request-body';
import { createRequestDeadline, TEXT_REQUEST_DEADLINE_MS, type RequestDeadline } from './request-deadline';
import { createMultipartBodyInspector, MultipartBodyError, MULTIPART_MAX_FIELD_BYTES, type MultipartPartMetadata } from './multipart-body-inspector';

export const MULTIPART_FILE_PAGE_BYTES = 64 * 1024;

/** Request-local, replayable pages. No whole-file Blob/File concatenation (which copies in Workers). */
export class MultipartFile {
	#pages: Uint8Array[] = [];
	#size = 0;
	#sealed = false;
	#disposed = false;
	#readers = new Set<ReadableStreamDefaultController<Uint8Array>>();
	constructor(readonly name: string, readonly type: string) {}
	get size(): number { return this.#size; }
	get retainedBytes(): number { return this.#pages.length * MULTIPART_FILE_PAGE_BYTES; }
	append(bytes: Uint8Array): void {
		if (this.#sealed || this.#disposed) throw new Error('Multipart file is not writable');
		for (let offset = 0; offset < bytes.length;) {
			const position = this.#size % MULTIPART_FILE_PAGE_BYTES;
			if (position === 0) this.#pages.push(new Uint8Array(MULTIPART_FILE_PAGE_BYTES));
			const length = Math.min(bytes.length - offset, MULTIPART_FILE_PAGE_BYTES - position);
			this.#pages[this.#pages.length - 1]!.set(bytes.subarray(offset, offset + length), position);
			this.#size += length; offset += length;
		}
	}
	seal(): void { this.#sealed = true; }
	stream(): ReadableStream<Uint8Array> {
		let index = 0;
		let target: ReadableStreamDefaultController<Uint8Array>;
		return new ReadableStream<Uint8Array>({
			start: controller => {
				target = controller;
				if (this.#disposed) controller.error(new Error('Multipart file is unavailable'));
				else this.#readers.add(controller);
			},
			pull: controller => {
				if (this.#disposed || !this.#sealed) {
					this.#readers.delete(controller); controller.error(new Error('Multipart file is unavailable')); return;
				}
				if (index === this.#pages.length) { this.#readers.delete(controller); controller.close(); return; }
				const page = this.#pages[index]!;
				// Hand out at most one copied page. A transport/consumer cannot mutate
				// the bytes retained for an authorized retry after definitive rejection.
				controller.enqueue(page.slice(0, Math.min(MULTIPART_FILE_PAGE_BYTES, this.#size - index++ * MULTIPART_FILE_PAGE_BYTES)));
			},
			cancel: () => { this.#readers.delete(target); },
		}, { highWaterMark: 0 });
	}
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true; this.#pages = [];
		for (const controller of this.#readers) controller.error(new Error('Multipart file is unavailable'));
		this.#readers.clear();
	}
}

export type MultipartValue = string | MultipartFile;
export type MultipartBody = Record<string, MultipartValue | MultipartValue[]>;

/** Parse once, with bounded metadata and page storage; never populate Hono's formData/body cache. */
export async function readStreamingMultipartBody(
	request: Request,
	limits: { maxFiles: number; maxFileBytes: number },
	deadline?: RequestDeadline,
): Promise<MultipartBody> {
	const owner = deadline ?? createRequestDeadline(Date.now() + TEXT_REQUEST_DEADLINE_MS, request.signal);
	const body: MultipartBody = Object.create(null);
	const files: MultipartFile[] = [];
	let part: MultipartPartMetadata | undefined, file: MultipartFile | undefined;
	let field: Uint8Array | undefined, fieldSize = 0;
	let bits = 0, accumulator = 0, base64Ended = false;
	let base64Text: TextDecoder | undefined, decoded: Uint8Array | undefined;
	const append = (bytes: Uint8Array) => {
		if (file) file.append(bytes);
		else {
			if (!field || fieldSize + bytes.length > field.length) throw new MultipartBodyError('field_size');
			field.set(bytes, fieldSize); fieldSize += bytes.length;
		}
	};
	const decodeBase64 = (text: string) => {
		decoded ??= new Uint8Array(MULTIPART_FILE_PAGE_BYTES);
		let size = 0;
		for (let i = 0; i < text.length && !base64Ended; i++) {
			// Node's native MIME parser passes UTF-8-decoded text to Buffer's
			// forgiving base64 decoder, which reads the low byte of UTF-16 units.
			const byte = text.charCodeAt(i) & 255;
			if (byte === 61) { base64Ended = true; break; }
			const value = byte >= 65 && byte <= 90 ? byte - 65 : byte >= 97 && byte <= 122 ? byte - 71
				: byte >= 48 && byte <= 57 ? byte + 4 : byte === 43 || byte === 45 ? 62 : byte === 47 || byte === 95 ? 63 : -1;
			if (value < 0) continue;
			accumulator = (accumulator << 6) | value; bits += 6;
			if (bits >= 8) { bits -= 8; decoded[size++] = accumulator >>> bits; }
			accumulator &= (1 << bits) - 1;
		}
		append(decoded.subarray(0, size));
	};
	const inspector = createMultipartBodyInspector(request.headers.get('Content-Type') ?? '', limits, {
		start(metadata) {
			part = metadata; fieldSize = 0; bits = 0; accumulator = 0; base64Ended = false;
			base64Text = metadata.base64 ? new TextDecoder('utf-8', { ignoreBOM: true, fatal: false }) : undefined;
			file = metadata.filename === undefined ? undefined : new MultipartFile(metadata.filename, metadata.type);
			if (file) files.push(file);
			else field ??= new Uint8Array(MULTIPART_MAX_FIELD_BYTES);
		},
		data(bytes) {
			if (!part) throw new MultipartBodyError('malformed');
			if (!part.base64) { append(bytes); return; }
			for (let offset = 0; offset < bytes.length && !base64Ended; offset += MULTIPART_FILE_PAGE_BYTES) {
				decodeBase64(base64Text!.decode(bytes.subarray(offset, offset + MULTIPART_FILE_PAGE_BYTES), { stream: true }));
			}
		},
		end() {
			if (!part) throw new MultipartBodyError('malformed');
			if (base64Text && !base64Ended) decodeBase64(base64Text.decode());
			file?.seal();
			const value: MultipartValue = file ?? new TextDecoder('utf-8', { ignoreBOM: !part.stripBom, fatal: false }).decode(field?.subarray(0, fieldSize));
			const previous = body[part.name];
			if (previous === undefined) body[part.name] = part.name.endsWith('[]') ? [value] : value;
			else if (Array.isArray(previous)) previous.push(value);
			else body[part.name] = [previous, value];
			part = undefined; file = undefined;
		},
	});
	let upload: ReturnType<typeof boundRequestBody> | undefined;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	try {
		owner.throwIfStopped();
		if (!request.body) throw new MultipartBodyError('malformed');
		upload = boundRequestBody(request.body, owner, MAX_REQUEST_BODY_BYTES, inspector);
		reader = upload.body.getReader();
		while (!(await owner.wait(() => reader!.read())).done) { /* The scanner consumes each borrowed chunk. */ }
		owner.throwIfStopped();
		return body;
	} catch (error) {
		for (const entry of files) entry.dispose();
		throw error;
	} finally {
		upload?.dispose(); reader?.releaseLock(); inspector.dispose(); field = undefined; decoded = undefined; base64Text = undefined;
		if (!deadline) owner.dispose();
	}
}
