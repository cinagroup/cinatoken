import {
	MAX_GENERATION_PROVIDER_RESPONSES_PER_REQUEST,
	MAX_PROVIDER_ATTEMPT_FACTS_PER_REQUEST,
	providerAttemptAvailabilityForHttpStatus,
	type GenerationProviderResponseSnapshot,
	type InsertProviderAttemptAvailability,
	type ProviderAttemptAvailabilityOutcome,
	type ProviderAttemptAvailabilityReason,
} from '@octafuse/core';
import type { RouteResult } from './model-router';
import { isPrivateByokRoute } from './byok-key-pool';

export type RequestTimingAttempt = {
	index: number;
	gateway_candidate_index: number | null;
	provider_id: string;
	provider_name: string | null;
	provider_key_id: string | null;
	provider_key_label: string | null;
	provider_key_fingerprint: string | null;
	is_byok: boolean;
	route_target_id: string;
	gateway_model_id: string | null;
	routed_service_tier: 'flex' | 'priority' | null;
	model: string | null;
	start_ms: number;
	headers_ms: number | null;
	headers_elapsed_ms: number | null;
	status: number | null;
	error: string | null;
	selected: boolean;
	availability: ProviderAttemptAvailabilityOutcome | null;
	availability_reason: ProviderAttemptAvailabilityReason | null;
	availability_http_status: number | null;
	availability_observed_at: string | null;
};

/**
 * Minimal request-local attempt projection permitted in public Router Metadata.
 * Internal route/provider/key identities, upstream model names, timings and
 * error text are deliberately excluded from this DTO.
 */
export type RouterMetadataTimingAttempt = {
	index: number;
	candidateIndex: number | null;
	providerName: string | null;
	status: number | null;
	selected: boolean;
};

export type RequestTimingSnapshot = {
	gatewayOverheadMs: number | null;
	upstreamResponseMs: number | null;
	finalUpstreamHeadersMs: number | null;
	firstReasoningTokenMs: number | null;
	firstTokenMs: number | null;
	streamDurationMs: number | null;
	upstreamAttemptCount: number;
	upstreamFailoverCount: number;
	timingMetadata: string | null;
	providerAttempts: InsertProviderAttemptAvailability[];
	providerResponses: GenerationProviderResponseSnapshot[] | null;
};

const PUBLIC_GENERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

function now(): number {
	if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
		return performance.now();
	}
	return Date.now();
}

function ms(value: number): number {
	return Math.max(0, Math.round(value));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function publicAttemptString(value: string | null | undefined): string | undefined {
	return value != null
		&& value.length > 0
		&& value.length <= 200
		&& !CONTROL_CHAR_PATTERN.test(value)
		? value
		: undefined;
}

function publicGenerationId(value: string | null | undefined): string | undefined {
	return value != null && PUBLIC_GENERATION_ID_PATTERN.test(value) ? value : undefined;
}

export { providerAttemptAvailabilityForHttpStatus };

export class RequestTimingCollector {
	private readonly startedAt = now();
	private dispatchStartedAt: number | null = null;
	private dispatchStartedMs: number | null = null;
	private finalHeadersAt: number | null = null;
	private gatewayOverheadMs: number | null = null;
	private upstreamResponseMs: number | null = null;
	private finalUpstreamHeadersMs: number | null = null;
	private firstByteMs: number | null = null;
	private firstEventMs: number | null = null;
	private firstReasoningTokenMs: number | null = null;
	private firstTokenMs: number | null = null;
	private streamDurationMs: number | null = null;
	private streamCompletedAt: number | null = null;
	private upstreamFailoverCount = 0;
	private modelFallbackCount = 0;
	private readonly attempts: RequestTimingAttempt[] = [];

	elapsed(): number {
		return ms(now() - this.startedAt);
	}

	markGatewayComplete(): void {
		if (this.gatewayOverheadMs != null) return;
		this.gatewayOverheadMs = this.elapsed();
	}

	markUpstreamDispatchStart(): void {
		if (this.dispatchStartedAt != null) return;
		this.dispatchStartedAt = now();
		this.dispatchStartedMs = this.elapsed();
	}

	startAttempt(route: RouteResult): RequestTimingAttempt {
		this.markUpstreamDispatchStart();
		const attempt: RequestTimingAttempt = {
			index: this.attempts.length + 1,
			gateway_candidate_index:
				typeof route.gatewayCandidateIndex === 'number'
				&& Number.isSafeInteger(route.gatewayCandidateIndex)
					? route.gatewayCandidateIndex
					: null,
			provider_id: route.providerId,
			provider_name: route.providerName || null,
			provider_key_id: route.providerKeyId ?? null,
			provider_key_label: route.providerKeyLabel ?? null,
			provider_key_fingerprint: route.providerKeyFingerprint ?? null,
			is_byok: isPrivateByokRoute(route),
			route_target_id: route.targetId,
			gateway_model_id: route.gatewayModelId ?? null,
			routed_service_tier:
				route.gatewayRequestedServiceTier === 'flex'
				|| route.gatewayRequestedServiceTier === 'priority'
					? route.gatewayRequestedServiceTier
					: null,
			model: route.providerModelName ?? null,
			start_ms: this.elapsed(),
			headers_ms: null,
			headers_elapsed_ms: null,
			status: null,
			error: null,
			selected: false,
			availability: null,
			availability_reason: null,
			availability_http_status: null,
			availability_observed_at: null,
		};
		this.attempts.push(attempt);
		return attempt;
	}

	markAttemptHeaders(attempt: RequestTimingAttempt | undefined, status: number): void {
		if (!attempt) return;
		const availability = providerAttemptAvailabilityForHttpStatus(status);
		attempt.availability = availability.outcome;
		attempt.availability_reason = availability.reason;
		attempt.availability_http_status = status;
		attempt.availability_observed_at = new Date().toISOString();
		if (attempt.headers_ms != null) return;
		const elapsed = this.elapsed();
		attempt.headers_ms = ms(elapsed - attempt.start_ms);
		attempt.headers_elapsed_ms = elapsed;
		attempt.status = status;
	}

	markAttemptError(
		attempt: RequestTimingAttempt | undefined,
		error: unknown,
		options?: { clientCancelled?: boolean },
	): void {
		if (!attempt) return;
		attempt.error = errorMessage(error).slice(0, 300);
		attempt.availability = options?.clientCancelled ? 'excluded' : 'unavailable';
		attempt.availability_reason = options?.clientCancelled
			? 'client_cancelled'
			: 'network_error';
		attempt.availability_http_status = null;
		attempt.availability_observed_at = new Date().toISOString();
	}

	markAttemptFailover(attempt: RequestTimingAttempt | undefined): void {
		if (!attempt) return;
		this.upstreamFailoverCount += 1;
	}

	/** An outer model fallback continues after the final provider of one model failed. */
	markModelFallback(hadUpstreamAttempt = true): void {
		this.markEndpointFallback(true, hadUpstreamAttempt);
	}

	/** Outer endpoint orchestration continues; partition=none may stay on the same model. */
	markEndpointFallback(modelChanged: boolean, hadUpstreamAttempt = true): void {
		if (modelChanged) this.modelFallbackCount += 1;
		if (hadUpstreamAttempt) this.upstreamFailoverCount += 1;
	}

	/** Record only a model transition; the dispatcher records endpoint failover separately. */
	markModelTransition(): void {
		this.modelFallbackCount += 1;
	}

	markFinalAttempt(attempt: RequestTimingAttempt | undefined): void {
		if (!attempt) return;
		attempt.selected = true;
		if (attempt.headers_elapsed_ms != null && this.dispatchStartedMs != null && this.upstreamResponseMs == null) {
			this.upstreamResponseMs = ms(attempt.headers_elapsed_ms - this.dispatchStartedMs);
		}
		if (attempt.headers_ms != null && this.finalUpstreamHeadersMs == null) {
			this.finalUpstreamHeadersMs = attempt.headers_ms;
		}
		if (this.finalHeadersAt == null && attempt.headers_elapsed_ms != null) {
			this.finalHeadersAt = this.startedAt + attempt.headers_elapsed_ms;
		}
		if (this.finalHeadersAt != null && this.streamCompletedAt != null && this.streamDurationMs == null) {
			this.streamDurationMs = ms(this.streamCompletedAt - this.finalHeadersAt);
		}
	}

	/**
	 * Final body/protocol evidence can refine an initially accepted HTTP result.
	 * Only the selected successful attempt is eligible: caller cancellation is
	 * excluded from uptime, while a malformed/truncated provider response counts
	 * as unavailable without discarding the actual upstream HTTP status.
	 */
	finalizeSelectedAttemptAvailability(options: {
		clientCancelled?: boolean;
		invalidResponse?: boolean;
	}): void {
		const attempt = [...this.attempts].reverse().find((candidate) => candidate.selected);
		if (!attempt || attempt.availability !== 'available') return;
		if (options.clientCancelled === true) {
			attempt.availability = 'excluded';
			attempt.availability_reason = 'client_cancelled';
			attempt.availability_observed_at = new Date().toISOString();
			return;
		}
		if (options.invalidResponse === true) {
			attempt.availability = 'unavailable';
			attempt.availability_reason = 'invalid_response';
			attempt.availability_observed_at = new Date().toISOString();
		}
	}

	markFirstByte(): void {
		if (this.firstByteMs != null) return;
		this.firstByteMs = this.elapsed();
	}

	markFirstEvent(): void {
		if (this.firstEventMs != null) return;
		this.firstEventMs = this.elapsed();
	}

	markFirstReasoningToken(): void {
		if (this.firstReasoningTokenMs != null) return;
		this.firstReasoningTokenMs = this.elapsed();
	}

	markFirstToken(): void {
		if (this.firstTokenMs != null) return;
		this.firstTokenMs = this.elapsed();
	}

	markStreamComplete(): void {
		if (this.streamDurationMs != null) return;
		this.streamCompletedAt = now();
		if (this.finalHeadersAt == null) return;
		this.streamDurationMs = ms(this.streamCompletedAt - this.finalHeadersAt);
	}

	/** Return a fresh, explicitly allow-listed view for public Router Metadata. */
	routerMetadataAttempts(): RouterMetadataTimingAttempt[] {
		return this.attempts.map((attempt) => ({
			index: attempt.index,
			candidateIndex: attempt.gateway_candidate_index,
			providerName: attempt.provider_name,
			status: attempt.status,
			selected: attempt.selected,
		}));
	}

	snapshot(upstreamMessageId?: string | null): RequestTimingSnapshot {
		const metadata = {
			first_byte_ms: this.firstByteMs,
			first_event_ms: this.firstEventMs,
			model_fallback_count: this.modelFallbackCount,
			attempts: this.attempts,
		};
		const hasMetadata =
			this.firstByteMs != null ||
			this.firstEventMs != null ||
			this.modelFallbackCount > 0 ||
			this.attempts.length > 0;
		const providerAttempts = this.attempts.length > MAX_PROVIDER_ATTEMPT_FACTS_PER_REQUEST
			? []
			: this.attempts.flatMap((attempt): InsertProviderAttemptAvailability[] => (
				attempt.availability == null
				|| attempt.availability_reason == null
				|| attempt.availability_observed_at == null
					? []
					: [{
						attemptIndex: attempt.index,
						routeTargetId: attempt.route_target_id,
						providerId: attempt.provider_id,
						outcome: attempt.availability,
						reason: attempt.availability_reason,
						httpStatus: attempt.availability_http_status,
						observedAtIso: attempt.availability_observed_at,
					}]
			));
		const selectedMessageId = publicGenerationId(upstreamMessageId);
		const providerResponses = this.attempts.length === 0
			|| this.attempts.length > MAX_GENERATION_PROVIDER_RESPONSES_PER_REQUEST
			? null
			: this.attempts.map((attempt): GenerationProviderResponseSnapshot => {
				const endpointId = publicAttemptString(attempt.route_target_id);
				const modelPermaslug = publicAttemptString(attempt.gateway_model_id);
				const providerName = publicAttemptString(attempt.provider_name);
				return {
					status: Number.isSafeInteger(attempt.status)
						&& attempt.status! >= 100
						&& attempt.status! <= 599
						? attempt.status
						: null,
					...(endpointId ? { endpoint_id: endpointId } : {}),
					...(attempt.selected && selectedMessageId ? { id: selectedMessageId } : {}),
					is_byok: attempt.is_byok,
					...(Number.isSafeInteger(attempt.headers_ms) && attempt.headers_ms! >= 0 ? {
						latency: attempt.headers_ms!,
					} : {}),
					...(modelPermaslug ? { model_permaslug: modelPermaslug } : {}),
					...(providerName ? { provider_name: providerName } : {}),
					...(attempt.routed_service_tier ? {
						routed_service_tier: attempt.routed_service_tier,
					} : {}),
				};
			});
		return {
			gatewayOverheadMs: this.gatewayOverheadMs,
			upstreamResponseMs: this.upstreamResponseMs,
			finalUpstreamHeadersMs: this.finalUpstreamHeadersMs,
			firstReasoningTokenMs: this.firstReasoningTokenMs,
			firstTokenMs: this.firstTokenMs,
			streamDurationMs: this.streamDurationMs,
			upstreamAttemptCount: this.attempts.length,
			upstreamFailoverCount: this.upstreamFailoverCount,
			timingMetadata: hasMetadata ? JSON.stringify(metadata) : null,
			providerAttempts,
			providerResponses,
		};
	}
}
