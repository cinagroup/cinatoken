import { EMPTY_USAGE } from '../proxy';
import { markUpstreamOutcomeUnknown, type ProxyDispatchResult } from '../failover-dispatch';
import { createResourceCompletionGroup } from '../resource-completion';
import {
	createAudioRequestLifecycle,
	validateAudioUpstreamUrl,
	type AudioRequestLifecycleOptions,
	type AudioFetch,
} from './audio-request-lifecycle';
import { ownUpstreamResponse } from './owned-upstream-response';
import { UpstreamResponseBodyTooLargeError, resolveResponseByteLimit } from './bounded-response-body';

export type NativeMediaOptions = AudioRequestLifecycleOptions & { timeoutMs?: number; maxResponseBytes?: number };
const MAX_NATIVE_RESPONSE_BYTES = 32 * 1024 * 1024;

function boundResponse(response: Response, maxBytes: number): Response {
	if (!response.body) return response;
	const reader = response.body.getReader();
	let bytes = 0;
	const body = new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				try {
					const next = await reader.read();
					if (next.done) {
						controller.close();
						reader.releaseLock();
						return;
					}
					bytes += next.value.byteLength;
					if (bytes > maxBytes) {
						void reader
							.cancel('native_media_response_too_large')
							.catch(() => undefined)
							.finally(() => reader.releaseLock());
						controller.error(new UpstreamResponseBodyTooLargeError(response.status));
						return;
					}
					controller.enqueue(next.value);
				} catch (error) {
					controller.error(error);
					try {
						reader.releaseLock();
					} catch {}
				}
			},
			cancel(reason) {
				return reader.cancel(reason).finally(() => reader.releaseLock());
			},
		},
		{ highWaterMark: 0 },
	);
	return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** Own upstream adapters through admission, headers, bounded bodies and final usage. */
export async function withNativeMediaDispatch<T extends ProxyDispatchResult>(
	signal: AbortSignal | undefined,
	options: NativeMediaOptions | undefined,
	run: (signal: AbortSignal, options: NativeMediaOptions) => Promise<T>,
): Promise<T> {
	const resources = createResourceCompletionGroup();
	options?.trackResourceCompletion?.(resources.completion);
	const lifecycle = createAudioRequestLifecycle(signal, options?.timeoutMs ?? 300_000, {
		...options,
		trackResourceCompletion: resources.track,
	});
	const fetchImpl: AudioFetch = async (input, init) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
		validateAudioUpstreamUrl(url);
		const response = await ((init?.method ?? 'GET').toUpperCase() === 'GET'
			? lifecycle.fetch(input, init)
			: lifecycle.dispatch(url, init ?? {}));
		const owned = ownUpstreamResponse(response, lifecycle.signal);
		resources.track(owned.resourceCompletion);
		return boundResponse(
			owned.response,
			resolveResponseByteLimit(options?.maxResponseBytes, MAX_NATIVE_RESPONSE_BYTES),
		);
	};
	try {
		const result = await lifecycle.wait(() =>
			run(lifecycle.signal, { ...options, fetchImpl, trackResourceCompletion: resources.track }),
		);
		if (result.resourceCompletion) resources.track(result.resourceCompletion);
		const meta = result.meta ?? {};
		if (
			lifecycle.dispatchStarted &&
			(result.response.status >= 500 ||
				result.response.status === 499 ||
				(result.response.status >= 300 && result.response.status < 400))
		) {
			meta.upstreamOutcomeUnknown = true;
			meta.failoverForbidden = true;
		}
		const usagePromise = lifecycle
			.wait(() => result.usagePromise)
			.catch(() => {
				if (lifecycle.dispatchStarted) {
					meta.upstreamOutcomeUnknown = true;
					meta.failoverForbidden = true;
				}
				return {
					...EMPTY_USAGE,
					cancelled: lifecycle.getAbortReason() === 'client_abort',
					stream_error: 'Native media request stopped before complete usage',
				};
			})
			.finally(lifecycle.clear);
		resources.seal();
		return { ...result, meta, usagePromise, resourceCompletion: resources.completion };
	} catch (error) {
		lifecycle.clear();
		resources.seal();
		if (lifecycle.admissionFailed) throw error;
		throw lifecycle.dispatchStarted ? markUpstreamOutcomeUnknown(error) : error;
	}
}
