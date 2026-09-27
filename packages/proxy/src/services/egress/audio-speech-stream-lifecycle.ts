import type { UsageFromStream } from '../proxy';
import { observeResourceCleanup, type ResourceCompletion, type ResourceCompletionOutcome } from '../resource-completion';
import type { RequestTimingCollector } from '../request-timing';
import type { createAudioRequestLifecycle } from './audio-request-lifecycle';

export type SpeechRequestLifecycle = ReturnType<typeof createAudioRequestLifecycle>;

/** Only locally authored protocol messages may enter stream errors/logs. */
export class SpeechProtocolError extends Error {}

export function cancelSpeechReader(reader: ReadableStreamDefaultReader<Uint8Array>, reason: string): ResourceCompletion {
	const cleanup = observeResourceCleanup(() => reader.cancel(reason));
	reader.releaseLock();
	return cleanup;
}

/** Own settlement independently of downstream pulls or cancellation acknowledgement. */
export function createSpeechStreamLifecycle(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	request: SpeechRequestLifecycle,
	usage: UsageFromStream,
	markOutcomeUnknown: () => void,
	timing?: RequestTimingCollector | null,
) {
	let closed = false;
	let controller: ReadableStreamDefaultController<Uint8Array>;
	let resolveUsage!: (value: UsageFromStream) => void;
	const usagePromise = new Promise<UsageFromStream>(resolve => { resolveUsage = resolve; });
	let resolveResource!: (value: ResourceCompletionOutcome | ResourceCompletion) => void;
	const resourceCompletion: ResourceCompletion = new Promise(resolve => { resolveResource = resolve; });
	const finish = (cancelled: boolean, error?: Error, sourceEnded = false): boolean => {
		if (closed) return false;
		closed = true;
		if (cancelled || error) markOutcomeUnknown();
		if (cancelled) usage.cancelled = true;
		if (error) usage.stream_error = error.message;
		request.signal.removeEventListener('abort', onAbort);
		request.clear();
		if (sourceEnded) { reader.releaseLock(); resolveResource('confirmed'); }
		else resolveResource(cancelSpeechReader(reader, 'speech_stream_finished'));
		timing?.markStreamComplete();
		resolveUsage({ ...usage });
		return true;
	};
	const onAbort = (): void => {
		const timedOut = request.getAbortReason() === 'gateway_timeout';
		const error = new SpeechProtocolError(timedOut ? 'Audio speech request deadline exceeded' : 'Audio speech request was cancelled');
		if (finish(!timedOut, timedOut ? error : undefined)) controller.error(error);
	};
	return {
		usagePromise,
		resourceCompletion,
		get closed() { return closed; },
		start(target: ReadableStreamDefaultController<Uint8Array>) {
			controller = target;
			request.signal.addEventListener('abort', onAbort, { once: true });
			if (request.signal.aborted) onAbort();
		},
		read: () => request.wait(() => reader.read()),
		complete(sourceEnded = false) {
			if (finish(false, undefined, sourceEnded)) controller.close();
		},
		fail(error: unknown) {
			const safe = error instanceof SpeechProtocolError ? error : new SpeechProtocolError('Audio speech stream failed');
			if (finish(false, safe)) controller.error(safe);
		},
		cancel() { finish(true); },
	};
}
