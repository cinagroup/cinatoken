import type { RequestDeadline } from './request-deadline';

export const MAX_REQUEST_BODY_BYTES = 50 * 1024 * 1024;

export interface RequestBodyInspector {
	write(chunk: Uint8Array): void | Promise<void>;
	end(): void | Promise<void>;
	dispose(): void;
}

export class RequestBodyTooLargeError extends Error {
	constructor() {
		super('Request body exceeds the maximum allowed size');
		this.name = 'RequestBodyTooLargeError';
	}
}

/** Pull-based upload guard. EOF releases the reader, NOT the request deadline. */
export function boundRequestBody(
	source: ReadableStream<Uint8Array>,
	deadline: RequestDeadline,
	maxBytes = MAX_REQUEST_BODY_BYTES,
	inspector?: RequestBodyInspector,
) {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('Invalid body limit');
	const reader = source.getReader();
	let terminal = false;
	let bytes = 0;
	let target: ReadableStreamDefaultController<Uint8Array>;
	const finish = (): void => {
		terminal = true;
		deadline.signal.removeEventListener('abort', onAbort);
		inspector?.dispose();
	};
	const cancelReader = (reason: unknown): void => {
		void reader.cancel(reason).catch(() => undefined);
		reader.releaseLock();
	};
	const fail = (error: unknown): void => {
		if (terminal) return;
		finish();
		target.error(error);
		cancelReader(error);
	};
	const onAbort = (): void => fail(deadline.signal.reason);
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			target = controller;
			deadline.signal.addEventListener('abort', onAbort, { once: true });
			if (deadline.signal.aborted) onAbort();
		},
		async pull(controller) {
			if (terminal) return;
			try {
				const chunk = await deadline.wait(() => reader.read());
				if (terminal) return;
				if (chunk.done) {
					if (inspector) await deadline.wait(async () => inspector.end());
					if (terminal) return;
					deadline.throwIfStopped();
					finish();
					reader.releaseLock();
					controller.close();
					return;
				}
				bytes += chunk.value.byteLength;
				if (bytes > maxBytes) throw new RequestBodyTooLargeError();
				if (inspector) await deadline.wait(async () => inspector.write(chunk.value));
				if (terminal) return;
				deadline.throwIfStopped();
				controller.enqueue(chunk.value);
			} catch (error) {
				fail(error);
			}
		},
		cancel() {
			if (terminal) return;
			finish();
			cancelReader('request_body_consumer_closed');
		},
	}, { highWaterMark: 0 });
	return {
		body,
		/** An early 401/413/etc must not retain an unread upload or wait for cancel ACK. */
		dispose: () => fail(new Error('Request body is no longer needed')),
	};
}
