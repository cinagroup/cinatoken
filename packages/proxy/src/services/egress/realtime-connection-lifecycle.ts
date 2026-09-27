import { RequestAuxiliaryAuthLimitError, type RequestAuxiliaryAuthBudget } from '@octafuse/core';
import { createRequestDeadline, RequestExecutionStoppedError } from '../request-deadline';
import { DASHSCOPE_REALTIME_CONNECT_TIMEOUT_MS } from '../dashscope-realtime-guardrails';
import { GatewayErrorCode } from '../gateway-error-codes';
import { buildOpenRouterErrorBody } from '../openrouter-error-protocol';
import { markUpstreamOutcomeUnknown, type ProxyDispatchResult } from '../failover-dispatch';
import { EMPTY_USAGE } from '../proxy';
import { ambiguousDispatchedStatusMeta } from './ambiguous-upstream-status';

export type RealtimeConnectionOptions = {
	auxiliaryAuth?: RequestAuxiliaryAuthBudget;
	connectDeadlineAtMs?: number;
};

/** Connection only: never turn the connection deadline into a session deadline. */
export function createRealtimeConnectionLifecycle(signal: AbortSignal | undefined, options: RealtimeConnectionOptions) {
	const owner = createRequestDeadline(Math.min(
		options.connectDeadlineAtMs ?? Infinity, Date.now() + DASHSCOPE_REALTIME_CONNECT_TIMEOUT_MS,
	), signal);
	let dispatched = false;
	let admissionFailed = false;
	return {
		...owner,
		async admit(beforeDispatch?: () => Promise<void>): Promise<void> {
			owner.throwIfStopped();
			// Admission is a durable write. Observe completion even if cancellation
			// wins; the caller still owns releasing/forfeiting its reservation.
			try { await beforeDispatch?.(); }
			catch (error) { admissionFailed = true; throw error; }
			owner.throwIfStopped();
		},
		markDispatched(): void { owner.throwIfStopped(); dispatched = true; },
		failure(error: unknown): ProxyDispatchResult {
			if (admissionFailed || error instanceof RequestAuxiliaryAuthLimitError) throw error;
			if (owner.signal.aborted || error instanceof RequestExecutionStoppedError) {
				const timedOut = (owner.signal.reason instanceof RequestExecutionStoppedError
					&& owner.signal.reason.reason === 'deadline_exceeded')
					|| (signal?.reason instanceof RequestExecutionStoppedError && signal.reason.reason === 'deadline_exceeded');
				const status = timedOut ? 504 : 499;
				const code = timedOut ? GatewayErrorCode.requestDeadlineExceeded : GatewayErrorCode.requestCancelled;
				return {
					response: new Response(JSON.stringify(buildOpenRouterErrorBody({
						skin: 'chat', status, legacyCode: code, errorType: timedOut ? 'timeout' : 'provider_unavailable',
						message: timedOut ? 'Realtime upstream connection deadline exceeded' : 'Realtime connection was cancelled',
					})), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-OctaFuse-Error-Code': code } }),
					usagePromise: Promise.resolve(EMPTY_USAGE), upstreamRequestId: null,
					meta: { gatewayGeneratedError: true, failoverForbidden: true, upstreamOutcomeUnknown: dispatched, admissionDeniedPreDispatch: !dispatched },
				};
			}
			if (dispatched) throw markUpstreamOutcomeUnknown(new Error('Realtime upstream connection outcome could not be confirmed'));
			throw error;
		},
	};
}
export type RealtimeConnectionLifecycle = ReturnType<typeof createRealtimeConnectionLifecycle>;

export function realtimeUpstreamHeaders(secret: string, upgrade = false): Headers {
	try { return new Headers({ Authorization: `Bearer ${secret}`, ...(upgrade ? { Upgrade: 'websocket' } : {}) }); }
	catch { throw new Error('Invalid realtime upstream authentication header'); }
}

/** UTF-8 byte limit, never forward reserved close codes such as 1005/1006. */
export function realtimeCloseParameters(code: number, reason: string): { code: number; reason: string } {
	const valid = Number.isInteger(code) && ((code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999));
	let bounded = ''; let bytes = 0;
	const encoder = new TextEncoder();
	for (const character of reason) {
		const size = encoder.encode(character).byteLength;
		if (bytes + size > 123) break;
		bytes += size; bounded += character;
	}
	return { code: valid ? code : 1011, reason: bounded };
}

/** No provider body is needed for an Upgrade rejection; never drain it. */
export function realtimeRejectedResponse(status: number, headers: Headers, requestId: string | null): ProxyDispatchResult {
	if (!Number.isInteger(status) || status < 300 || status > 599) {
		throw markUpstreamOutcomeUnknown(new Error('Invalid realtime upstream handshake'));
	}
	const safeHeaders = new Headers();
	const retryAfter = headers.get('Retry-After');
	if (retryAfter) safeHeaders.set('Retry-After', retryAfter);
	return {
		response: new Response(null, { status, headers: safeHeaders }),
		usagePromise: Promise.resolve(EMPTY_USAGE),
		upstreamRequestId: requestId,
		meta: ambiguousDispatchedStatusMeta(status),
	};
}
