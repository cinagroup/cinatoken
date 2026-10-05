import { createJsonUploadBody } from './json-upload-body';
import { observeResourceCleanup, type ResourceCompletion, type ResourceCompletionOutcome } from '../resource-completion';
import type { WorkerdLengthAwareSource } from './workerd-length-aware-source';

/** Snapshot before admission; encoding completion alone is not consumer EOF. */
export function createOwnedJsonUploadBody(value: Record<string, unknown>, signal: AbortSignal) {
	// Only the outer owner listens to the request signal, so it records whether
	// transport had started before stopping the internal synchronous encoder.
	const raw = createJsonUploadBody(value, new AbortController().signal, () => signal.throwIfAborted());
	return ownEncoder(raw, signal);
}

function ownEncoder(raw: ReturnType<typeof createJsonUploadBody>, signal: AbortSignal) {
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let controller: ReadableStreamDefaultController<Uint8Array>;
	let closed = false, pulled = false;
	let resolveResource!: (outcome: ResourceCompletionOutcome | ResourceCompletion) => void;
	const resourceCompletion: ResourceCompletion = new Promise(resolve => { resolveResource = resolve; });
	const finish = (outcome: ResourceCompletionOutcome | ResourceCompletion) => {
		if (closed) return;
		closed = true;
		signal.removeEventListener('abort', stop);
		raw.dispose();
		reader?.releaseLock(); reader = undefined;
		resolveResource(outcome);
	};
	const streamSource = {
		// workerd's declared source length, not a manually forced HTTP header.
		expectedLength: raw.contentLength,
		start(source) { controller = source; },
		async pull(source) {
			if (closed) return;
			pulled = true;
			try {
				reader ??= raw.body.getReader();
				const next = await reader.read();
				if (closed) return;
				if (next.done) { source.close(); finish('confirmed'); }
				else source.enqueue(next.value);
			} catch {
				if (!closed) { source.error(new Error('JSON upload encoding failed')); finish('unconfirmed'); }
			}
		},
		cancel() {
			// The wrapped source is our own encoder, whose synchronous teardown is
			// still observed. This does not acknowledge remote delivery or billing.
			const completion = observeResourceCleanup(() => reader ? reader.cancel() : raw.body.cancel());
			finish(completion);
			return completion.then(() => undefined);
		},
	} satisfies WorkerdLengthAwareSource;
	const body = new ReadableStream<Uint8Array>(streamSource, { highWaterMark: 0 });
	function stop() {
		if (closed) return;
		const untouched = !pulled && !body.locked;
		controller.error(new Error('JSON upload stopped'));
		finish(untouched ? 'confirmed' : 'unconfirmed');
	}
	signal.addEventListener('abort', stop, { once: true });
	if (signal.aborted) stop();
	return { body, contentLength: raw.contentLength, preparedSnapshot: raw.preparedSnapshot,
		digestSha256: raw.digestSha256, resourceCompletion, stop };
}
