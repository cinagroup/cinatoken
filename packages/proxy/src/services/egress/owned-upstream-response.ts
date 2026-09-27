import { observeResourceCleanup, type ResourceCompletion, type ResourceCompletionOutcome } from '../resource-completion';

/** Own a fetched body through EOF or its real cancellation ACK, including non-2xx bodies.
 * Cancellation stops delivery immediately; accounting never waits on this resource channel.
 * Fetch/header lifetime remains owned by the enclosing dispatch attempt.
 */
export function ownUpstreamResponse(response: Response, signal?: AbortSignal): {
	response: Response;
	resourceCompletion: ResourceCompletion;
} {
	if (!response.body) return { response, resourceCompletion: Promise.resolve('confirmed') };
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body.getReader();
	let controller: ReadableStreamDefaultController<Uint8Array>;
	let closed = false;
	let resolve!: (outcome: ResourceCompletionOutcome | ResourceCompletion) => void;
	const resourceCompletion: ResourceCompletion = new Promise(done => { resolve = done; });
	const finish = (outcome: ResourceCompletionOutcome | ResourceCompletion): void => {
		if (closed) return;
		closed = true;
		signal?.removeEventListener('abort', abort);
		reader?.releaseLock();
		reader = undefined;
		resolve(outcome);
	};
	const cancel = (): void => {
		if (closed) return;
		const source = reader!;
		finish(observeResourceCleanup(() => source.cancel('upstream_response_stopped')));
	};
	const abort = (): void => {
		if (closed) return;
		cancel();
		controller.error(new Error('Upstream response body stopped'));
	};
	const body = new ReadableStream<Uint8Array>({
		start(value) { controller = value; },
		async pull(value) {
			if (closed) return;
			try {
				const next = await reader!.read();
				if (closed) return;
				if (next.done) { value.close(); finish('confirmed'); }
				else value.enqueue(next.value);
			} catch {
				if (closed) return;
				cancel();
				value.error(new Error('Upstream response body unavailable'));
			}
		},
		cancel,
	}, { highWaterMark: 0 });
	const owned = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
	// Register only after controller construction, including late headers after abort.
	signal?.addEventListener('abort', abort, { once: true });
	if (signal?.aborted) abort();
	return { response: owned, resourceCompletion };
}
