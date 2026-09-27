import type { RequestCapacityLease } from './request-capacity';

/**
 * Own a response body through EOF/error or cancellation cleanup. No tee, eager
 * read, concatenation or extra payload copy. This observes application delivery,
 * NOT a network acknowledgement, garbage collection or database commit.
 */
export function capacityResponseBody(
	body: ReadableStream<Uint8Array>,
	lease: RequestCapacityLease,
	signal: AbortSignal,
	trackCleanup: (task: Promise<void>) => void,
): ReadableStream<Uint8Array> {
	const release = lease.retain();
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	try { reader = body.getReader(); }
	catch (error) { release(); throw error; }
	let lifecycle: { signal: AbortSignal; trackCleanup: (task: Promise<void>) => void } | undefined = { signal, trackCleanup };
	let stopped = false;
	let controller: ReadableStreamDefaultController<Uint8Array>;
	const finish = (): void => {
		lifecycle?.signal.removeEventListener('abort', onAbort);
		// The scheduler closes over the Hono context. Drop it even if a consumer
		// retains the completed Response or reader after delivery has finished.
		lifecycle = undefined;
		reader?.releaseLock();
		reader = undefined;
		release();
	};
	const cancel = (): void => {
		if (stopped) return;
		stopped = true;
		lifecycle!.signal.removeEventListener('abort', onAbort);
		// A producer may keep resources until cancel resolves. Stop client delivery
		// promptly, but do not return its reservation before cleanup settles.
		const cleanup = reader!.cancel(new Error('Gateway response delivery stopped'))
			.then(() => undefined, () => undefined).finally(finish);
		lifecycle!.trackCleanup(cleanup);
	};
	function onAbort(): void {
		if (stopped) return;
		cancel();
		controller.error(new Error('Gateway response delivery stopped'));
	}
	return new ReadableStream<Uint8Array>({
		start(target) {
			controller = target;
			lifecycle!.signal.addEventListener('abort', onAbort, { once: true });
			if (lifecycle!.signal.aborted) onAbort();
		},
		async pull(target) {
			if (stopped) return;
			try {
				const result = await reader!.read();
				if (stopped) return; // Cancellation cleanup owns the reservation now.
				if (result.done) { stopped = true; finish(); target.close(); }
				else target.enqueue(result.value);
			} catch {
				if (stopped) return;
				stopped = true;
				finish();
				target.error(new Error('Gateway response delivery failed'));
			}
		},
		cancel,
	}, { highWaterMark: 0 });
}
