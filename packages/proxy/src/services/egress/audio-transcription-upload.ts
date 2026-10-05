import type { ResourceCompletion, ResourceCompletionOutcome } from '../resource-completion';
import type { WorkerdLengthAwareSource } from './workerd-length-aware-source';

const PAGE_BYTES = 64 * 1024;
const TEXT_UNITS = 8 * 1024;
const encoder = new TextEncoder();
const normalizeLines = (value: string) => value.replace(/\r\n|\r|\n/g, '\r\n');
const escapeName = (value: string) => value.replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/"/g, '%22');

/** Keep surrogate pairs together while bounding UTF-8 encoding allocations. */
function textEnd(value: string, offset: number): number {
	let end = Math.min(offset + TEXT_UNITS, value.length);
	if (end < value.length && value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff) end--;
	return end;
}

/** File bytes remain request-owned and must not be mutated until dispatch completes. */
export function createAudioTranscriptionUpload(
	fields: FormData,
	file: { filename: string; mimeType: string; bytes: Uint8Array },
	signal: AbortSignal,
) {
	const boundary = `----cinatoken-${crypto.randomUUID()}`;
	const parts: Array<string | Uint8Array> = [];
	for (const [name, value] of fields) {
		if (typeof value !== 'string') throw new Error('Audio transcription scalar field expected');
		parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${escapeName(normalizeLines(name))}"\r\n\r\n`, normalizeLines(value), '\r\n');
	}
	// Only normalize metadata; never copy the complete audio into a Blob.
	const mime = new Blob([], { type: file.mimeType }).type || 'application/octet-stream';
	parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${escapeName(file.filename)}"\r\nContent-Type: ${mime}\r\n\r\n`,
		file.bytes, `\r\n--${boundary}--\r\n`);
	return { ...ownUpload(parts, signal), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Separate closure: cleanup cannot retain the caller's FormData or file object. */
function ownUpload(parts: Array<string | Uint8Array>, signal: AbortSignal) {
	let contentLength = 0;
	for (const part of parts) {
		if (typeof part !== 'string') contentLength += part.byteLength;
		else for (let offset = 0; offset < part.length;) {
			const end = textEnd(part, offset);
			contentLength += encoder.encode(part.slice(offset, end)).byteLength;
			offset = end;
		}
	}
	let index = 0, offset = 0, closed = false, pulled = false;
	let source: ReadableStreamDefaultController<Uint8Array>;
	let resolveResource!: (outcome: ResourceCompletionOutcome) => void;
	const resourceCompletion: ResourceCompletion = new Promise(resolve => { resolveResource = resolve; });
	const finish = (outcome: ResourceCompletionOutcome) => {
		if (closed) return;
		closed = true;
		signal.removeEventListener('abort', stop);
		parts.length = 0; index = offset = 0;
		resolveResource(outcome);
	};
	const streamSource = {
		// workerd preserves the exact source length when constructing an HTTP body.
		// Node ignores this extension and uses the explicit Content-Length header.
		expectedLength: contentLength,
		start(controller) { source = controller; },
		pull(controller) {
			if (closed) return;
			pulled = true;
			try {
				while (index < parts.length) {
					const part = parts[index];
					if (offset === part.length) { index++; offset = 0; continue; }
					const end = typeof part === 'string' ? textEnd(part, offset) : Math.min(offset + PAGE_BYTES, part.length);
					// Isolate each handed-off page from the request's original bytes.
					controller.enqueue(typeof part === 'string' ? encoder.encode(part.slice(offset, end)) : part.slice(offset, end));
					offset = end;
					return;
				}
				// A final encoded/enqueued page is not consumer EOF.
				controller.close(); finish('confirmed');
			} catch {
				controller.error(new Error('Audio transcription upload encoding failed'));
				finish('unconfirmed');
			}
		},
		cancel() { finish('confirmed'); },
	} satisfies WorkerdLengthAwareSource;
	const body = new ReadableStream<Uint8Array>(streamSource, { highWaterMark: 0 });
	function stop() {
		if (closed) return;
		const untouched = !pulled && !body.locked;
		source.error(new Error('Audio transcription upload stopped'));
		// Source teardown is not acknowledgement from a consumer holding bytes.
		finish(untouched ? 'confirmed' : 'unconfirmed');
	}
	signal.addEventListener('abort', stop, { once: true });
	if (signal.aborted) stop();
	return { body, contentLength, resourceCompletion, stop };
}
