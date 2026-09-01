import type { UpstreamProtocol } from '../upstream-protocol';

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
	/** Canonical credential-free HTTP(S) origin captured from the inbound request URL. */
	requestOrigin?: string | null;
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
	model_id: string | null;
	provider_name: string | null;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	reasoning_tokens: number;
	input_image_count: number;
	output_image_count: number;
	upstream_message_id: string | null;
	workspace_id: string | null;
	request_origin: string | null;
	response_streamed: boolean | number | null;
	data_region: string | null;
	is_byok: boolean | number | null;
	charged_cost_usd: number | string | null;
	upstream_inference_cost_usd: number | string | null;
};

const GENERATION_DATA_REGIONS = new Set(['global', 'europe', 'us']);

/** Fail closed before persisting a partial or forged Generation metadata snapshot. */
export function assertGenerationSnapshotIsValid(params: InsertRequestLogParams): void {
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
	first_token_ms: number | null;
	stream_duration_ms: number | null;
	created_at: string;
};
