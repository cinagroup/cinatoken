import { MultipartFile, MULTIPART_FILE_PAGE_BYTES } from '../streaming-multipart-body';

const encoder = new TextEncoder();
const normalizeLines = (value: string) => value.replace(/\r\n|\r|\n/g, '\r\n');
const escapeName = (value: string) => value.replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/"/g, '%22');

/** Pull-only multipart serialization. No Request(FormData) or whole-file Blob for paged uploads. */
export function createMultipartUploadBody(
	fields: FormData,
	files: ReadonlyArray<{ filename: string; mimeType: string; payload: MultipartFile | Blob }>,
	signal: AbortSignal,
	/** Synchronous ownership notification after no reader can touch the retained files. */
	onFinished?: () => void,
) {
	const boundary = `----cinatoken-${crypto.randomUUID()}`;
	const parts: Array<Uint8Array | MultipartFile | Blob> = [];
	for (const [name, value] of fields) {
		if (typeof value !== 'string') throw new Error('Multipart scalar field expected');
		parts.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${escapeName(normalizeLines(name))}"\r\n\r\n${normalizeLines(value)}\r\n`));
	}
	for (const file of files) {
		// Blob's metadata normalization removes control characters without touching payload bytes.
		const mime = new Blob([], { type: file.mimeType }).type || 'application/octet-stream';
		parts.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${escapeName(file.filename || 'image.png')}"\r\nContent-Type: ${mime}\r\n\r\n`),
			file.payload, encoder.encode('\r\n'));
	}
	parts.push(encoder.encode(`--${boundary}--\r\n`));
	const contentLength = parts.reduce((sum, part) => sum + (part instanceof Uint8Array ? part.length : part.size), 0);
	let index = 0, offset = 0, closed = false;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let pending: Uint8Array | undefined;
	let target: ReadableStreamDefaultController<Uint8Array>;
	const releaseReader = (reason?: unknown) => {
		if (!reader) return;
		if (reason !== undefined) void reader.cancel(reason).catch(() => undefined);
		reader.releaseLock(); reader = undefined;
	};
	const finish = (error?: unknown) => {
		if (closed) return;
		closed = true; signal.removeEventListener('abort', onAbort);
		releaseReader(error); pending = undefined; parts.length = 0;
		onFinished?.();
	};
	const fail = (error: unknown) => { if (!closed) { finish(error); target.error(error); } };
	const onAbort = () => fail(signal.reason ?? new Error('Multipart upload stopped'));
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			target = controller; signal.addEventListener('abort', onAbort, { once: true });
			if (signal.aborted) onAbort();
		},
		async pull(controller) {
			try {
				while (!closed) {
					if (pending) {
						const end = Math.min(offset + MULTIPART_FILE_PAGE_BYTES, pending.length);
						controller.enqueue(pending.slice(offset, end)); offset = end;
						if (offset === pending.length) { pending = undefined; offset = 0; }
						return;
					}
					if (reader) {
						const next = await reader.read();
						if (closed) return;
						if (next.done) { releaseReader(); index++; continue; }
						// MultipartFile already handed out an isolated page. Forward it
						// directly instead of allocating a second identical transport copy.
						if (next.value.length <= MULTIPART_FILE_PAGE_BYTES) { controller.enqueue(next.value); return; }
						pending = next.value; continue;
					}
					const part = parts[index];
					if (!part) { finish(); controller.close(); return; }
					if (part instanceof Uint8Array) { pending = part; index++; }
					else reader = part.stream().getReader();
				}
			} catch (error) { fail(error); }
		},
		cancel(reason) { finish(reason ?? new Error('Multipart upload consumer closed')); },
	}, { highWaterMark: 0 });
	return { body, contentLength, contentType: `multipart/form-data; boundary=${boundary}`,
		dispose: () => fail(new Error('Multipart upload is no longer needed')) };
}
