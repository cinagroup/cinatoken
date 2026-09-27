import { observeResourceCleanup, type ResourceCompletion } from '../resource-completion';

/** Error raised after an upstream response exceeded the local buffering ceiling. */
export class UpstreamResponseBodyTooLargeError extends Error {
	constructor(readonly upstreamStatus: number) {
		super('Upstream response body exceeds the configured limit');
		this.name = 'UpstreamResponseBodyTooLargeError';
	}
}

/**
 * Consume decoded pieces without retaining the complete response text. The reader is
 * cancelled as soon as the declared or observed byte ceiling is crossed.
 */
export async function consumeResponseTextWithinLimit(
	response: Response,
	maxBytes: number,
	consumeText: (text: string) => void,
	signal?: AbortSignal,
	trackResourceCompletion?: (task: ResourceCompletion) => void,
): Promise<void> {
	let cancellation: ResourceCompletion | undefined;
	const cancel = (source: { cancel(reason?: unknown): Promise<unknown> } | null, reason: unknown): void => {
		if (!source || cancellation) return;
		cancellation = observeResourceCleanup(() => source.cancel(reason));
		trackResourceCompletion?.(cancellation);
	};
	if (signal?.aborted) {
		cancel(response.body, signal.reason);
		signal.throwIfAborted();
	}
	const declaredLength = Number(response.headers.get('content-length'));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		cancel(response.body, 'upstream_response_too_large');
		throw new UpstreamResponseBodyTooLargeError(response.status);
	}
	if (!response.body) return;

	const reader = response.body.getReader();
	// Decode while each borrowed transport chunk is owned by this read. Keeping
	// every byte chunk and concatenating it later retained two complete binary
	// copies (and allowed a transport reusing its buffer to corrupt prior data).
	const decoder = new TextDecoder();
	let byteLength = 0;
	let rejectPendingRead: ((reason: unknown) => void) | undefined;
	const onAbort = (): void => {
		rejectPendingRead?.(signal?.reason);
		// A tee/custom transport may never acknowledge cancellation. The read
		// itself must still terminate; observe cancellation without awaiting it.
		cancel(reader, signal?.reason);
	};
	signal?.addEventListener('abort', onAbort, { once: true });
	try {
		while (true) {
			signal?.throwIfAborted();
			const { done, value } = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
				rejectPendingRead = reject;
				void reader.read().then(resolve, reject);
			});
			rejectPendingRead = undefined;
			signal?.throwIfAborted();
			if (done) break;
			byteLength += value.byteLength;
			if (byteLength > maxBytes) {
				cancel(reader, 'upstream_response_too_large');
				throw new UpstreamResponseBodyTooLargeError(response.status);
			}
			try {
				// Transport chunks can be arbitrarily large. The consumer never receives
				// a second full-response text representation from a single decode.
				for (let offset = 0; offset < value.byteLength; offset += 64 * 1024) {
					signal?.throwIfAborted();
					consumeText(decoder.decode(value.subarray(offset, offset + 64 * 1024), { stream: true }));
				}
			} catch (error) {
				cancel(reader, 'upstream_response_inspection_failed');
				throw error;
			}
		}
		consumeText(decoder.decode());
	} catch (error) {
		cancel(reader, 'upstream_response_read_failed');
		throw error;
	} finally {
		rejectPendingRead = undefined;
		signal?.removeEventListener('abort', onAbort);
		reader.releaseLock();
	}

}

/** Buffer bounded text for existing small-body consumers; large JSON can use the sink directly. */
export async function responseTextWithinLimit(
	response: Response,
	maxBytes: number,
	signal?: AbortSignal,
	inspectText?: (text: string) => void,
	trackResourceCompletion?: (task: ResourceCompletion) => void,
): Promise<string> {
	const parts: string[] = []; let page = '';
	await consumeResponseTextWithinLimit(response, maxBytes, text => {
		inspectText?.(text);
		page += text;
		if (page.length >= 64 * 1024) { parts.push(page); page = ''; }
	}, signal, trackResourceCompletion);
	if (page) parts.push(page);
	return parts.join('');
}

export function resolveResponseByteLimit(configured: number | undefined, hardLimit: number): number {
	return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
		? Math.min(hardLimit, Math.floor(configured))
		: hardLimit;
}
