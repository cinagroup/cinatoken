import type { UpstreamProtocol } from '../upstream-protocol';
import type { InsertProviderAttemptAvailability } from './provider-attempt-availability';

export const MAX_GENERATION_PROVIDER_RESPONSES_PER_REQUEST = 32;
export const MAX_GENERATION_PROVIDER_RESPONSES_JSON_BYTES = 32 * 1024;

/** Credential-free OpenRouter-compatible facts for one upstream attempt. */
export type GenerationProviderResponseSnapshot = {
	status: number | null;
	endpoint_id?: string;
	id?: string;
	is_byok?: boolean;
	latency?: number;
	model_permaslug?: string;
	provider_name?: string;
	routed_service_tier?: 'flex' | 'priority';
};

/**
 * 共享类型：仓储与插入语句构造共用。
 * `pricing_audit` 的 JSON 形状见 `pricing-audit.ts`。
 */
export type InsertRequestLogParams = {
	id: string;
	userId: string | null;
	apiKeyId: string;
	/** Immutable request-time Workspace snapshot; must match the authenticated Gateway Key. */
	workspaceId: string;
	userEmail: string | null;
	modelId: string;
	providerId: string;
	providerModelName: string | null;
	modelName: string | null;
	providerName: string | null;
	requestBody: string | null;
	upstreamRequestBody: string | null;
	requestProtocol: UpstreamProtocol;
	requestOperation?: string | null;
	upstreamProtocol: UpstreamProtocol;
	upstreamOperation?: string | null;
	modelSurfaceId?: string | null;
	routePoolId?: string | null;
	routeTargetId?: string | null;
	adapter?: string | null;
	routeTrace?: string | null;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	reasoningTokens: number;
	totalTokens: number;
	/** Provider-reported token counters; null means the upstream supplied no authoritative value. */
	nativeTokensPrompt?: number | null;
	nativeTokensCompletion?: number | null;
	nativeTokensCached?: number | null;
	nativeTokensReasoning?: number | null;
	nativeTokensCompletionImages?: number | null;
	meteredCost: number;
	standardCost: number;
	chargedCost: number;
	/** Integer micro-unit debit used by the atomic Guardrail budget ledger. */
	budgetChargedMicros?: number | null;
	/** Request-start timestamp used to pin budget accounting across period boundaries. */
	budgetAccountedAt?: string | null;
	routeGroup: string;
	status: 'success' | 'error' | 'incomplete' | 'cancelled';
	latencyMs: number | null;
	gatewayOverheadMs?: number | null;
	upstreamResponseMs?: number | null;
	finalUpstreamHeadersMs?: number | null;
	firstReasoningTokenMs?: number | null;
	firstTokenMs?: number | null;
	streamDurationMs?: number | null;
	upstreamAttemptCount?: number | null;
	upstreamFailoverCount?: number | null;
	timingMetadata?: string | null;
	errorMessage: string | null;
	rawUsage: string | null;
	/** 计费审计 JSON 字符串；与 `RequestLogRow.pricing_audit` / `pricing-audit.ts` 对齐 */
	pricingAudit?: string | null;
	providerKeyId?: string | null;
	providerKeyLabel?: string | null;
	providerKeyFingerprint?: string | null;
	/** 上游响应头 request id（传输层追踪句柄） */
	upstreamRequestId?: string | null;
	/** 上游响应 body message id（应用层生成结果 id：chatcmpl-* / msg_* / responseId） */
	upstreamMessageId?: string | null;
	/** 计费种类：`image_tokens` | `image_per_image` | `audio_per_second` | `audio_tokens` | `audio_per_character` */
	billingKind?: string | null;
	/** 按张计费：参考图张数 */
	inputImageCount?: number;
	/** 按张计费：生成图张数 */
	outputImageCount?: number;
	/** 音频转写：计费时长（秒） */
	audioDurationSeconds?: number | null;
	/** TTS：上游返回的有效计费字符数 */
	audioCharacters?: number | null;
	/** OpenRouter request session snapshot; never used as a credential. */
	sessionId?: string | null;
	/** Canonical credential-free HTTP(S) origin captured from the inbound request URL. */
	requestOrigin?: string | null;
	/** Canonical credential-free origin from the explicit OpenRouter HTTP-Referer app header. */
	httpReferer?: string | null;
	/** Bounded User-Agent header captured for the owner-visible Generation record. */
	userAgent?: string | null;
	/** Whether the public response used a streaming transport. */
	responseStreamed?: boolean | null;
	/** OpenRouter-compatible request-time routing region snapshot. */
	dataRegion?: 'global' | 'europe' | 'us' | null;
	/** Request-time private BYOK decision; shared/platform provider keys are false. */
	isByok?: boolean | null;
	/** User-visible generation charge in USD; null when the billing currency is not provably USD. */
	chargedCostUsd?: number | null;
	/** Upstream inference cost in USD; null when the supplier cost is not provably USD. */
	upstreamInferenceCostUsd?: number | null;
	/** Canonical service tier reported by the upstream response. */
	serviceTier?: 'default' | 'flex' | 'priority' | null;
	/** OpenRouter-normalized reason the primary text generation terminated. */
	finishReason?: 'tool_calls' | 'stop' | 'length' | 'content_filter' | 'error' | null;
	/** Bounded provider-native termination reason for the primary generation. */
	nativeFinishReason?: string | null;
	/** Bounded, credential-free OpenRouter provider response snapshots. */
	providerResponses?: readonly GenerationProviderResponseSnapshot[] | null;
	/** Credential-free per-upstream-attempt facts, committed atomically with this request log. */
	providerAttempts?: readonly InsertProviderAttemptAvailability[];
};

/**
 * Least-privilege projection used by the public Generation metadata endpoint.
 * Keep this type intentionally narrow: request bodies, route traces, errors,
 * provider-key material and pricing audits must never be loaded by that path.
 */
export type GenerationRequestLogRow = {
	id: string;
	request_operation: string | null;
	status: string;
	created_at: string;
	latency_ms: number | null;
	final_upstream_headers_ms: number | null;
	stream_duration_ms: number | null;
	model_id: string | null;
	provider_name: string | null;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	reasoning_tokens: number;
	native_tokens_prompt: number | string | null;
	native_tokens_completion: number | string | null;
	native_tokens_cached: number | string | null;
	native_tokens_reasoning: number | string | null;
	native_tokens_completion_images: number | string | null;
	input_image_count: number;
	output_image_count: number;
	upstream_message_id: string | null;
	session_id: string | null;
	workspace_id: string | null;
	request_origin: string | null;
	http_referer: string | null;
	user_agent: string | null;
	response_streamed: boolean | number | null;
	data_region: string | null;
	is_byok: boolean | number | null;
	charged_cost_usd: number | string | null;
	upstream_inference_cost_usd: number | string | null;
	service_tier: string | null;
	finish_reason: string | null;
	native_finish_reason: string | null;
	provider_responses: string | null;
};

const GENERATION_DATA_REGIONS = new Set(['global', 'europe', 'us']);
const GENERATION_SERVICE_TIERS = new Set(['default', 'flex', 'priority']);
const GENERATION_FINISH_REASONS = new Set([
	'tool_calls', 'stop', 'length', 'content_filter', 'error',
]);
const GENERATION_CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const GENERATION_PROVIDER_RESPONSE_KEYS = new Set([
	'status',
	'endpoint_id',
	'id',
	'is_byok',
	'latency',
	'model_permaslug',
	'provider_name',
	'routed_service_tier',
]);

function assertGenerationNativeToken(value: unknown, label: string): void {
	if (value != null && (
		typeof value !== 'number'
		|| !Number.isSafeInteger(value)
		|| value < 0
	)) {
		throw new TypeError(`Generation ${label} must be a safe non-negative integer or null`);
	}
}

function assertGenerationProviderResponseString(
	value: unknown,
	label: string,
	maxLength = 200,
): asserts value is string {
	if (
		typeof value !== 'string'
		|| value.length === 0
		|| value.length > maxLength
		|| GENERATION_CONTROL_CHAR_PATTERN.test(value)
	) {
		throw new TypeError(`Generation provider response ${label} is invalid`);
	}
}

function assertGenerationProviderResponses(
	responses: readonly GenerationProviderResponseSnapshot[] | null | undefined,
): void {
	if (responses == null) return;
	if (!Array.isArray(responses) || responses.length > MAX_GENERATION_PROVIDER_RESPONSES_PER_REQUEST) {
		throw new TypeError('Generation provider responses are invalid');
	}
	for (const response of responses as readonly Record<string, unknown>[]) {
		if (response == null || typeof response !== 'object' || Array.isArray(response)) {
			throw new TypeError('Generation provider response is invalid');
		}
		if (Object.keys(response).some((key) => !GENERATION_PROVIDER_RESPONSE_KEYS.has(key))) {
			throw new TypeError('Generation provider response contains an unsupported field');
		}
		if (
			response.status !== null
			&& (
				typeof response.status !== 'number'
				|| !Number.isSafeInteger(response.status)
				|| response.status < 100
				|| response.status > 599
			)
		) throw new TypeError('Generation provider response status is invalid');
		for (const [field, maxLength] of [
			['endpoint_id', 200],
			['id', 200],
			['model_permaslug', 200],
			['provider_name', 200],
		] as const) {
			if (response[field] !== undefined) {
				assertGenerationProviderResponseString(response[field], field, maxLength);
			}
		}
		if (response.is_byok !== undefined && typeof response.is_byok !== 'boolean') {
			throw new TypeError('Generation provider response BYOK flag is invalid');
		}
		if (response.latency !== undefined && (
			typeof response.latency !== 'number'
			|| !Number.isSafeInteger(response.latency)
			|| response.latency < 0
		)) throw new TypeError('Generation provider response latency is invalid');
		if (
			response.routed_service_tier !== undefined
			&& response.routed_service_tier !== 'flex'
			&& response.routed_service_tier !== 'priority'
		) throw new TypeError('Generation provider response service tier is invalid');
	}
	if (
		new TextEncoder().encode(JSON.stringify(responses)).byteLength
		> MAX_GENERATION_PROVIDER_RESPONSES_JSON_BYTES
	) {
		throw new TypeError('Generation provider responses are too large');
	}
}

/** Validate and serialize a write snapshot after its least-privilege shape is proven. */
export function serializeGenerationProviderResponses(
	responses: readonly GenerationProviderResponseSnapshot[] | null | undefined,
): string | null {
	assertGenerationProviderResponses(responses);
	return responses == null ? null : JSON.stringify(responses);
}

/** Parse a database snapshot defensively before returning it through a public endpoint. */
export function parseGenerationProviderResponses(
	value: string | null | undefined,
): GenerationProviderResponseSnapshot[] | null {
	if (
		value == null
		|| new TextEncoder().encode(value).byteLength > MAX_GENERATION_PROVIDER_RESPONSES_JSON_BYTES
	) return null;
	try {
		const parsed: unknown = JSON.parse(value);
		assertGenerationProviderResponses(parsed as GenerationProviderResponseSnapshot[]);
		return parsed as GenerationProviderResponseSnapshot[];
	} catch {
		return null;
	}
}

/** Fail closed before persisting a partial or forged Generation metadata snapshot. */
export function assertGenerationSnapshotIsValid(params: InsertRequestLogParams): void {
	for (const [label, value] of [
		['native prompt tokens', params.nativeTokensPrompt],
		['native completion tokens', params.nativeTokensCompletion],
		['native cached tokens', params.nativeTokensCached],
		['native reasoning tokens', params.nativeTokensReasoning],
		['native completion image tokens', params.nativeTokensCompletionImages],
	] as const) assertGenerationNativeToken(value, label);
	assertGenerationProviderResponses(params.providerResponses);
	for (const [label, value] of [
		['HTTP referer', params.httpReferer],
		['User-Agent', params.userAgent],
	] as const) {
		if (
			value != null
			&& (
				typeof value !== 'string'
				|| value.length === 0
				|| value.length > 512
				|| GENERATION_CONTROL_CHAR_PATTERN.test(value)
			)
		) throw new TypeError(`Generation ${label} is invalid`);
	}
	if (params.httpReferer != null) {
		let referer: URL;
		try {
			referer = new URL(params.httpReferer);
		} catch {
			throw new TypeError('Generation HTTP referer is invalid');
		}
		if (
			(referer.protocol !== 'https:' && referer.protocol !== 'http:')
			|| referer.username !== ''
			|| referer.password !== ''
			|| referer.origin !== params.httpReferer
			|| referer.pathname !== '/'
			|| referer.search !== ''
			|| referer.hash !== ''
		) throw new TypeError('Generation HTTP referer must be a canonical credential-free HTTP(S) origin');
	}
	if (params.serviceTier != null && !GENERATION_SERVICE_TIERS.has(params.serviceTier)) {
		throw new TypeError('Generation service tier is invalid');
	}
	if (params.finishReason != null && !GENERATION_FINISH_REASONS.has(params.finishReason)) {
		throw new TypeError('Generation finish reason is invalid');
	}
	if (
		params.nativeFinishReason != null
		&& (
			typeof params.nativeFinishReason !== 'string'
			|| params.nativeFinishReason.length === 0
			|| params.nativeFinishReason.length > 128
			|| GENERATION_CONTROL_CHAR_PATTERN.test(params.nativeFinishReason)
		)
	) {
		throw new TypeError('Generation native finish reason is invalid');
	}
	const sessionRoundTrip = params.sessionId == null
		? null
		: new TextDecoder().decode(new TextEncoder().encode(params.sessionId));
	if (
		params.sessionId != null
		&& (
			typeof params.sessionId !== 'string'
			|| Array.from(params.sessionId).length > 256
			|| sessionRoundTrip !== params.sessionId
		)
	) {
		throw new TypeError('Generation session id is invalid');
	}
	const required = [
		params.requestOrigin,
		params.dataRegion,
		params.isByok,
		params.chargedCostUsd,
	];
	const hasSnapshot = required.some((value) => value != null);
	if (!hasSnapshot) {
		if (params.responseStreamed != null || params.upstreamInferenceCostUsd != null) {
			throw new TypeError('Generation metadata snapshot is incomplete');
		}
		return;
	}
	if (required.some((value) => value == null)) {
		throw new TypeError('Generation metadata snapshot is incomplete');
	}

	if (typeof params.requestOrigin !== 'string' || params.requestOrigin.length > 512) {
		throw new TypeError('Generation request origin is invalid');
	}
	let origin: URL;
	try {
		origin = new URL(params.requestOrigin);
	} catch {
		throw new TypeError('Generation request origin is invalid');
	}
	if (
		(origin.protocol !== 'https:' && origin.protocol !== 'http:')
		|| origin.username !== ''
		|| origin.password !== ''
		|| origin.origin !== params.requestOrigin
		|| origin.pathname !== '/'
		|| origin.search !== ''
		|| origin.hash !== ''
	) {
		throw new TypeError('Generation request origin must be a canonical credential-free HTTP(S) origin');
	}
	if (!GENERATION_DATA_REGIONS.has(params.dataRegion!)) {
		throw new TypeError('Generation data region is invalid');
	}
	if (typeof params.isByok !== 'boolean') {
		throw new TypeError('Generation BYOK snapshot must be boolean');
	}
	if (params.responseStreamed != null && typeof params.responseStreamed !== 'boolean') {
		throw new TypeError('Generation streaming snapshot must be boolean or null');
	}
	for (const [label, value] of [
		['charged USD cost', params.chargedCostUsd],
		['upstream USD cost', params.upstreamInferenceCostUsd],
	] as const) {
		if (value != null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
			throw new TypeError(`Generation ${label} must be a finite non-negative number or null`);
		}
	}
}

/** Bounded recent success sample used by request-time provider performance preferences. */
export type RoutePerformanceSample = {
	route_target_id: string;
	output_tokens: number;
	latency_ms: number | null;
	upstream_response_ms: number | null;
	final_upstream_headers_ms: number | null;
	first_reasoning_token_ms: number | null;
	first_token_ms: number | null;
	stream_duration_ms: number | null;
	created_at: string;
};
