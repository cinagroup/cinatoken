import type { RequestAuxiliaryAuthBudget } from '@octafuse/core';
import { observeResourceCleanup, type ResourceCompletion, type ResourceCompletionOutcome } from '../resource-completion';
import { createRequestDeadline, RequestExecutionStoppedError } from '../request-deadline';
import { buildOpenRouterErrorBody } from '../openrouter-error-protocol';
import { GatewayErrorCode } from '../gateway-error-codes';

export type AudioFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type AudioRequestLifecycleOptions = {
	fetchImpl?: AudioFetch;
	auxiliaryAuth?: RequestAuxiliaryAuthBudget;
	deadlineAtMs?: number;
	beforeUpstreamDispatch?: () => Promise<void>;
	/** Attempt-local cleanup sink, not the public request's host registration. */
	trackResourceCompletion?: (task: ResourceCompletion) => void;
};

/** Syntax/protocol validation only; Target allowlisting remains a separate gate. */
export function validateAudioUpstreamUrl(value: string): void {
	let url: URL;
	try { url = new URL(value); } catch { throw new Error('Invalid audio upstream URL'); }
	if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Invalid audio upstream protocol');
}

/** One attempt's I/O owner, tightened by the request's shared absolute ceiling. */
export function createAudioRequestLifecycle(
	requestSignal: AbortSignal | undefined,
	timeoutMs: number,
	options: AudioRequestLifecycleOptions,
) {
	const owner = createRequestDeadline(Math.min(options.deadlineAtMs ?? Infinity, Date.now() + timeoutMs), requestSignal);
	let dispatchStarted = false;
	let admissionFailed = false;
	const fetchImpl = options.fetchImpl ?? fetch;
	const waitForResponse = (operation: () => Promise<Response>): Promise<Response> => {
		let started = false;
		let resolveResource!: (value: ResourceCompletionOutcome | ResourceCompletion) => void;
		const completion: ResourceCompletion = new Promise(resolve => { resolveResource = resolve; });
		options.trackResourceCompletion?.(completion);
		return owner.wait(() => {
			started = true;
			let pending: Promise<Response>;
			try { pending = operation(); }
			catch (error) { resolveResource('unconfirmed'); throw error; }
			// A stopped wait may return before transport rejection/headers arrive.
			void pending.catch(() => { resolveResource('unconfirmed'); });
			return pending;
		}, response => {
			resolveResource(response.body
				? observeResourceCleanup(() => response.body!.cancel('audio_request_stopped'))
				: 'confirmed');
		}).then(response => {
			resolveResource('confirmed'); return response;
		}, error => {
			if (!started) resolveResource('confirmed');
			throw error;
		});
	};
	const readFetch: AudioFetch = (input, init) => waitForResponse(
		() => fetchImpl(input, { ...init, redirect: 'manual', signal: owner.signal }),
	);
	return {
		signal: owner.signal,
		clear: owner.dispose,
		wait: owner.wait,
		trackResourceCompletion: (task: ResourceCompletion) => { options.trackResourceCompletion?.(task); },
		fetch: readFetch,
		get dispatchStarted() { return dispatchStarted; },
		get admissionFailed() { return admissionFailed; },
		getAbortReason(): 'none' | 'client_abort' | 'gateway_timeout' {
			if (!owner.signal.aborted) return 'none';
			const reason = owner.signal.reason;
			return (reason instanceof RequestExecutionStoppedError && reason.reason === 'deadline_exceeded')
				|| (requestSignal?.reason instanceof RequestExecutionStoppedError && requestSignal.reason.reason === 'deadline_exceeded')
				? 'gateway_timeout' : 'client_abort';
		},
		async dispatch(input: string, init: RequestInit): Promise<Response> {
			owner.throwIfStopped();
			// Never abandon a durable admission write with owner.wait(). Its
			// completion/failure must remain owned even when cancellation wins.
			try { await options.beforeUpstreamDispatch?.(); }
			catch (error) { admissionFailed = true; throw error; }
			owner.throwIfStopped();
			return waitForResponse(() => {
				dispatchStarted = true;
				return fetchImpl(input, { ...init, redirect: 'manual', signal: owner.signal });
			});
		},
	};
}

/** Preserve local 499, which the provider-error normalizer intentionally maps to 502. */
export function audioRequestAbortResponse(timedOut: boolean): Response {
	const status = timedOut ? 504 : 499;
	const code = timedOut ? GatewayErrorCode.requestDeadlineExceeded : GatewayErrorCode.requestCancelled;
	return new Response(JSON.stringify(buildOpenRouterErrorBody({
		skin: 'chat', status, legacyCode: code, errorType: timedOut ? 'timeout' : 'provider_unavailable',
		message: timedOut ? 'Audio request deadline exceeded' : 'Audio request was cancelled',
	})), {
		status,
		headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-OctaFuse-Error-Code': code },
	});
}
