import type { RequestBodyInspector } from './bounded-request-body';

// Resource ceilings for the multipart envelope, not smaller image capacities.
export const MULTIPART_MAX_HEADER_BYTES = 16 * 1024;
export const MULTIPART_MAX_FIELD_BYTES = 64 * 1024;
export const MULTIPART_MAX_FIELDS_BYTES = 128 * 1024;
export const MULTIPART_MAX_PARTS = 64;
const MAX_FRAMING_BYTES = 16 * 1024;

type Failure = 'boundary' | 'headers' | 'parts' | 'files' | 'file_size'
	| 'field_size' | 'fields_size' | 'framing' | 'malformed';
const MESSAGES: Record<Failure, string> = {
	boundary: 'Invalid multipart boundary', headers: 'Multipart part headers exceed the allowed size',
	parts: 'Too many multipart parts', files: 'Too many uploaded files',
	file_size: 'Image file exceeds the allowed size', field_size: 'Multipart field exceeds the allowed size',
	fields_size: 'Multipart fields exceed the total allowed size', framing: 'Multipart framing exceeds the allowed size',
	malformed: 'Invalid multipart body',
};
export class MultipartBodyError extends Error {
	readonly status: 400 | 413;
	constructor(readonly failure: Failure) {
		super(MESSAGES[failure]); this.name = 'MultipartBodyError';
		// Preserve the existing image count/size 400 contract. Envelope limits are 413.
		this.status = ['boundary', 'files', 'file_size', 'malformed'].includes(failure) ? 400 : 413;
	}
}

/** Bounded HTTP parameter parsing; duplicate boundaries are ambiguous and rejected. */
function boundaryFrom(contentType: string): string {
	if (contentType.length > 1024) throw new MultipartBodyError('boundary');
	const media = /^multipart\/form-data\s*/i.exec(contentType);
	if (!media) throw new MultipartBodyError('boundary');
	let cursor = media[0].length, boundary: string | undefined;
	const parameter = /;\s*([!#$%&'*+.^_`|~\w-]+)\s*=\s*(?:"((?:[^"\\\r\n]|\\[^\r\n])*)"|([!#$%&'*+.^_`|~\w-]+))\s*/y;
	while (cursor < contentType.length) {
		parameter.lastIndex = cursor;
		const match = parameter.exec(contentType);
		if (!match) throw new MultipartBodyError('boundary');
		cursor = parameter.lastIndex;
		if (match[1]!.toLowerCase() === 'boundary') {
			if (boundary !== undefined) throw new MultipartBodyError('boundary');
			boundary = match[2] === undefined ? match[3]! : match[2].replace(/\\(.)/g, '$1');
		}
	}
	// RFC 2046 boundary: 1–70 ASCII bchars, with no trailing space.
	if (!boundary || boundary.length > 70 || !/^[0-9A-Za-z'()+_,\-./:=? ]*[0-9A-Za-z'()+_,\-./:=?]$/.test(boundary)) {
		throw new MultipartBodyError('boundary');
	}
	return boundary;
}

export type MultipartPartMetadata = { name: string; filename?: string; type: string; base64: boolean; stripBom: boolean };
/** Synchronous borrowed slices: a consumer must copy before returning, never retain the input buffer. */
export interface MultipartPartSink {
	start(part: MultipartPartMetadata): void;
	data(bytes: Uint8Array): void;
	end(): void;
}

/** Bounded framing scanner; optional events let a consumer avoid whole-form materialization. */
export function createMultipartBodyInspector(
	contentType: string, limits: { maxFiles: number; maxFileBytes: number },
	sink?: MultipartPartSink,
): RequestBodyInspector {
	if (!Number.isSafeInteger(limits.maxFiles) || limits.maxFiles < 0
		|| !Number.isSafeInteger(limits.maxFileBytes) || limits.maxFileBytes < 0) throw new RangeError('Invalid multipart limits');
	// Lazy initialization preserves auth-first behavior for an unread invalid form.
	let initialized = false, disposed = false, firstBoundary = true;
	let boundary = '', needle = new Uint8Array(), prefix: number[] = [];
	let state: 'body' | 'suffix' | 'headers' | 'closed' = 'body';
	let matched = 0, suffix = -1, padding = 0, headerLength = 0;
	let header: Uint8Array | undefined;
	let parts = 0, files = 0, file = false, inPart = false;
	let partBytes = 0, fieldBytes = 0, framingBytes = 0;
	const singleByte = new Uint8Array(1);
	let paddingBytes: Uint8Array | undefined;
	const active = () => { if (disposed) throw new MultipartBodyError('malformed'); };
	const setNeedle = (value: string) => {
		needle = new TextEncoder().encode(value);
		prefix = new Array<number>(needle.length).fill(0);
		for (let i = 1, length = 0; i < needle.length; i++) {
			while (length > 0 && needle[i] !== needle[length]) length = prefix[length - 1]!;
			if (needle[i] === needle[length]) length++;
			prefix[i] = length;
		}
	};
	const account = (count: number) => {
		if (!inPart) {
			framingBytes += count;
			if (framingBytes > MAX_FRAMING_BYTES) throw new MultipartBodyError('framing');
		} else if (file) {
			partBytes += count;
			if (partBytes > limits.maxFileBytes) throw new MultipartBodyError('file_size');
		} else {
			partBytes += count; fieldBytes += count;
			if (partBytes > MULTIPART_MAX_FIELD_BYTES) throw new MultipartBodyError('field_size');
			if (fieldBytes > MULTIPART_MAX_FIELDS_BYTES) throw new MultipartBodyError('fields_size');
		}
	};
	const emit = (bytes: Uint8Array) => { account(bytes.length); if (inPart) sink?.data(bytes); };
	const emitByte = (byte: number) => { singleByte[0] = byte; emit(singleByte); };
	const scanByte = (byte: number) => {
		while (matched > 0 && byte !== needle[matched]) {
			const next = prefix[matched - 1]!;
			emit(needle.subarray(0, matched - next)); matched = next;
		}
		if (byte === needle[matched]) {
			if (++matched === needle.length) { state = 'suffix'; matched = 0; suffix = -1; padding = 0; }
		} else emitByte(byte);
	};
	const parseHeader = async () => {
		if (!header) throw new MultipartBodyError('malformed');
		// No original payload enters native formData. A seven-byte discriminator
		// detects THIS runtime's base64 transfer decoding and scalar BOM handling.
		// Inspector-only callers still use an empty body.
		const probe = new Blob([`--${boundary}\r\n`, header.subarray(0, headerLength), sink ? '\uFEFFQUJD' : '', `\r\n--${boundary}--\r\n`]);
		let form: FormData;
		try {
			form = await new Response(probe, { headers: { 'Content-Type': `multipart/form-data; boundary="${boundary}"` } }).formData();
		} catch { throw new MultipartBodyError('malformed'); }
		active();
		const entries = [...form.entries()];
		if (entries.length !== 1) throw new MultipartBodyError('malformed');
		const [name, value] = entries[0]!;
		file = value instanceof Blob;
		if (file && ++files > limits.maxFiles) throw new MultipartBodyError('files');
		if (sink) {
			const size = typeof value === 'string' ? value.length : value.size;
			if (typeof value === 'string' ? ![3, 4, 5].includes(size) : ![3, 7].includes(size)) throw new MultipartBodyError('malformed');
			sink.start({ name, ...(typeof value === 'string' ? {} : { filename: value.name }),
				type: typeof value === 'string' ? '' : value.type, base64: size === 3,
				stripBom: typeof value === 'string' && !value.startsWith('\uFEFF') });
		}
		partBytes = 0; inPart = true; headerLength = 0; state = 'body';
	};
	return {
		async write(chunk) {
			active();
			if (!initialized) {
				boundary = boundaryFrom(contentType);
				// Native parsers may accept a preamble without a final CRLF. Find
				// that FIRST delimiter too, so its file cannot evade the counters.
				setNeedle(`--${boundary}`);
				header = new Uint8Array(MULTIPART_MAX_HEADER_BYTES + 4);
				initialized = true;
			}
			for (let i = 0; i < chunk.length; i++) {
				const byte = chunk[i]!;
				if (state === 'closed') {
					framingBytes += chunk.length - i;
					if (framingBytes > MAX_FRAMING_BYTES) throw new MultipartBodyError('framing');
					break;
				} else if (state === 'headers') {
					if (!header || headerLength === header.length) throw new MultipartBodyError('headers');
					header[headerLength++] = byte;
					if (headerLength >= 4 && byte === 10 && header[headerLength - 2] === 13
						&& header[headerLength - 3] === 10 && header[headerLength - 4] === 13) await parseHeader();
				} else if (state === 'suffix') {
					// RFC 2046 permits transport padding before the delimiter's CRLF.
					// Count it without retaining it, and bound even an unfinished line.
					if (suffix === -1 && (byte === 32 || byte === 9)) {
						if (++padding > MAX_FRAMING_BYTES) throw new MultipartBodyError('framing');
						if (sink) { paddingBytes ??= new Uint8Array(MAX_FRAMING_BYTES); paddingBytes[padding - 1] = byte; }
						continue;
					}
					if (suffix === -1 && (byte === 13 || (byte === 45 && padding === 0))) { suffix = byte; continue; }
					if (suffix === 13 && byte === 10) {
						framingBytes += padding;
						if (framingBytes > MAX_FRAMING_BYTES) throw new MultipartBodyError('framing');
						if (++parts > MULTIPART_MAX_PARTS) throw new MultipartBodyError('parts');
						if (inPart) sink?.end();
						if (firstBoundary) { firstBoundary = false; setNeedle(`\r\n--${boundary}`); }
						state = 'headers'; inPart = false;
					} else if (suffix === 45 && byte === 45) { if (inPart) sink?.end(); state = 'closed'; inPart = false; }
					else {
						// A boundary prefix followed by other bytes is ordinary binary
						// content. Re-feed the suffix to preserve overlapping candidates.
						emit(needle);
						if (paddingBytes) emit(paddingBytes.subarray(0, padding)); else account(padding);
						state = 'body';
						if (suffix !== -1) scanByte(suffix);
						scanByte(byte);
					}
				} else if (matched === 0 && byte !== needle[0]) {
					const next = chunk.indexOf(needle[0]!, i + 1), end = next < 0 ? chunk.length : next;
					emit(chunk.subarray(i, end)); i = end - 1;
				} else scanByte(byte);
			}
		},
		end() { active(); if (!initialized || state !== 'closed') throw new MultipartBodyError('malformed'); },
		dispose() { disposed = true; header = undefined; paddingBytes = undefined; prefix = []; needle = new Uint8Array(); },
	};
}
