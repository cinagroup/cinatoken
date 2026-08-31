import type { GatewayErrorCodeValue } from "./gateway-error-codes";
import { GatewayErrorCode } from "./gateway-error-codes";

/** Stable cross-skin error vocabulary published by OpenRouter. */
export type OpenRouterErrorType =
	| "authentication"
	| "permission_denied"
	| "payment_required"
	| "rate_limit_exceeded"
	| "provider_overloaded"
	| "provider_unavailable"
	| "invalid_request"
	| "invalid_prompt"
	| "not_found"
	| "precondition_failed"
	| "payload_too_large"
	| "unprocessable"
	| "content_policy_violation"
	| "context_length_exceeded"
	| "max_tokens_exceeded"
	| "token_limit_exceeded"
	| "string_too_long"
	| "timeout"
	| "server"
	| "unmapped";

export type OpenRouterErrorSkin = "chat" | "responses" | "anthropic";

export type PublicErrorBodyOptions = {
	skin: OpenRouterErrorSkin;
	status: number;
	message: string;
	errorType: OpenRouterErrorType;
	/** Existing client/observability compatibility. Never contains provider secrets. */
	legacyCode?: GatewayErrorCodeValue;
	metadata?: Record<string, unknown>;
	providerCode?: string | null;
	requestId?: string | null;
};

const MAX_PUBLIC_ERROR_MESSAGE_CHARS = 512;
const MAX_PROVIDER_CODE_CHARS = 96;
const MAX_METADATA_KEYS = 32;
const MAX_METADATA_ARRAY_ITEMS = 32;
const MAX_METADATA_DEPTH = 3;

const ERROR_TYPE_BY_GATEWAY_CODE: Record<
	GatewayErrorCodeValue,
	OpenRouterErrorType
> = {
	[GatewayErrorCode.invalidJson]: "invalid_request",
	[GatewayErrorCode.missingModel]: "invalid_request",
	[GatewayErrorCode.modelNotFound]: "not_found",
	[GatewayErrorCode.budgetExceeded]: "payment_required",
	[GatewayErrorCode.authFailed]: "authentication",
	[GatewayErrorCode.permissionDenied]: "permission_denied",
	[GatewayErrorCode.authRateLimited]: "rate_limit_exceeded",
	[GatewayErrorCode.publicCatalogRateLimited]: "rate_limit_exceeded",
	[GatewayErrorCode.publicCatalogUnavailable]: "server",
	[GatewayErrorCode.internalError]: "server",
	[GatewayErrorCode.routeNotFound]: "not_found",
	[GatewayErrorCode.payloadTooLarge]: "payload_too_large",
	[GatewayErrorCode.noRoute]: "not_found",
	[GatewayErrorCode.routeResolutionFailed]: "provider_unavailable",
	[GatewayErrorCode.invalidRequest]: "invalid_request",
	[GatewayErrorCode.invalidPresetReference]: "invalid_request",
	[GatewayErrorCode.presetNotFound]: "not_found",
	[GatewayErrorCode.presetInvalid]: "invalid_request",
	[GatewayErrorCode.guardrailBlocked]: "permission_denied",
	[GatewayErrorCode.guardrailInvalid]: "invalid_request",
	[GatewayErrorCode.zdrNoRoute]: "not_found",
	[GatewayErrorCode.dataCollectionNoRoute]: "not_found",
	[GatewayErrorCode.zdrToolsUnsupported]: "invalid_request",
	[GatewayErrorCode.upstreamRequestFailed]: "provider_unavailable",
	[GatewayErrorCode.upstreamResponseTooLarge]: "provider_unavailable",
	[GatewayErrorCode.responsesStateRouteUnavailable]: "invalid_request",
	[GatewayErrorCode.responsesUnsupportedStateOperation]: "invalid_request",
	[GatewayErrorCode.circuitSensitiveContent]: "rate_limit_exceeded",
	[GatewayErrorCode.circuitClientError]: "invalid_request",
	[GatewayErrorCode.circuitUpstreamCapacityExhausted]: "rate_limit_exceeded",
	[GatewayErrorCode.upstreamContentFilter]: "content_policy_violation",
	[GatewayErrorCode.upstreamInvalidRequest]: "invalid_request",
	[GatewayErrorCode.upstreamRateLimited]: "rate_limit_exceeded",
	[GatewayErrorCode.upstreamAuthFailed]: "provider_unavailable",
	[GatewayErrorCode.upstreamNotFound]: "provider_unavailable",
	[GatewayErrorCode.upstreamServerError]: "provider_unavailable",
	[GatewayErrorCode.upstreamTimeout]: "timeout",
};

const STATUS_BY_ERROR_TYPE: Record<OpenRouterErrorType, number> = {
	authentication: 401,
	permission_denied: 403,
	payment_required: 402,
	rate_limit_exceeded: 429,
	provider_overloaded: 529,
	provider_unavailable: 502,
	invalid_request: 400,
	invalid_prompt: 400,
	not_found: 404,
	precondition_failed: 412,
	payload_too_large: 413,
	unprocessable: 422,
	content_policy_violation: 400,
	context_length_exceeded: 400,
	max_tokens_exceeded: 400,
	token_limit_exceeded: 400,
	string_too_long: 400,
	timeout: 504,
	server: 500,
	unmapped: 500,
};

const RESPONSE_CODE_BY_ERROR_TYPE: Record<OpenRouterErrorType, string> = {
	rate_limit_exceeded: "rate_limit_exceeded",
	context_length_exceeded: "invalid_prompt",
	invalid_request: "invalid_prompt",
	content_policy_violation: "image_content_policy_violation",
	authentication: "server_error",
	provider_overloaded: "server_error",
	provider_unavailable: "server_error",
	timeout: "server_error",
	server: "server_error",
	payment_required: "server_error",
	permission_denied: "server_error",
	invalid_prompt: "server_error",
	not_found: "server_error",
	precondition_failed: "server_error",
	payload_too_large: "server_error",
	unprocessable: "server_error",
	max_tokens_exceeded: "server_error",
	token_limit_exceeded: "server_error",
	string_too_long: "server_error",
	unmapped: "server_error",
};

const ANTHROPIC_TYPE_BY_ERROR_TYPE: Record<OpenRouterErrorType, string> = {
	authentication: "authentication_error",
	permission_denied: "permission_error",
	payment_required: "billing_error",
	not_found: "not_found_error",
	rate_limit_exceeded: "rate_limit_error",
	provider_overloaded: "overloaded_error",
	timeout: "timeout_error",
	context_length_exceeded: "invalid_request_error",
	content_policy_violation: "invalid_request_error",
	invalid_request: "invalid_request_error",
	invalid_prompt: "invalid_request_error",
	precondition_failed: "invalid_request_error",
	payload_too_large: "invalid_request_error",
	unprocessable: "invalid_request_error",
	max_tokens_exceeded: "invalid_request_error",
	token_limit_exceeded: "invalid_request_error",
	string_too_long: "invalid_request_error",
	provider_unavailable: "api_error",
	server: "api_error",
	unmapped: "api_error",
};

function collapseWhitespace(value: string): string {
	return value
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Remove credential-shaped fragments before any provider or runtime text becomes public. */
export function sanitizePublicErrorMessage(
	value: string,
	fallback = "Request failed"
): string {
	let message = collapseWhitespace(value);
	message = message
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
		.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
		.replace(
			/\b(api[_ -]?key|access[_ -]?token|authorization)(\s*[:=]\s*)[^\s,;]+/gi,
			"$1$2[redacted]"
		)
		.replace(/(https?:\/\/[^\s/:@]+:)[^\s/@]+@/gi, "$1[redacted]@");
	if (!message) message = fallback;
	return message.length <= MAX_PUBLIC_ERROR_MESSAGE_CHARS
		? message
		: `${message.slice(0, MAX_PUBLIC_ERROR_MESSAGE_CHARS - 1)}…`;
}

function sanitizeProviderCode(value: unknown): string | null {
	if (typeof value !== "string" && typeof value !== "number") return null;
	const normalized = String(value).trim();
	if (!normalized || !/^[A-Za-z0-9_.:/-]+$/.test(normalized)) return null;
	return normalized.slice(0, MAX_PROVIDER_CODE_CHARS);
}

function sanitizeMetadataValue(value: unknown, depth: number): unknown {
	if (value == null || typeof value === "boolean") return value;
	if (typeof value === "number")
		return Number.isFinite(value) ? value : undefined;
	if (typeof value === "string") return sanitizePublicErrorMessage(value, "");
	if (depth >= MAX_METADATA_DEPTH) return undefined;
	if (Array.isArray(value)) {
		return value
			.slice(0, MAX_METADATA_ARRAY_ITEMS)
			.map((item) => sanitizeMetadataValue(item, depth + 1))
			.filter((item) => item !== undefined);
	}
	if (typeof value !== "object") return undefined;
	const sanitized: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value).slice(0, MAX_METADATA_KEYS)) {
		if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key)) continue;
		const next = sanitizeMetadataValue(item, depth + 1);
		if (next !== undefined) sanitized[key] = next;
	}
	return sanitized;
}

function sanitizeMetadata(
	metadata: Record<string, unknown> | undefined
): Record<string, unknown> {
	const sanitized = sanitizeMetadataValue(metadata ?? {}, 0);
	return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
		? (sanitized as Record<string, unknown>)
		: {};
}

export function openRouterErrorTypeForGatewayCode(
	code: GatewayErrorCodeValue
): OpenRouterErrorType {
	return ERROR_TYPE_BY_GATEWAY_CODE[code];
}

export function openRouterStatusForErrorType(
	errorType: OpenRouterErrorType
): number {
	return STATUS_BY_ERROR_TYPE[errorType];
}

export function openRouterStatusForGatewayCode(
	code: GatewayErrorCodeValue
): number {
	return openRouterStatusForErrorType(openRouterErrorTypeForGatewayCode(code));
}

export function inferOpenRouterErrorSkin(path: string): OpenRouterErrorSkin {
	return /(?:^|\/)messages\/?$/.test(path) ? "anthropic" : "chat";
}

export function buildOpenRouterErrorBody(
	options: PublicErrorBodyOptions
): Record<string, unknown> {
	const message = sanitizePublicErrorMessage(options.message);
	const metadata = sanitizeMetadata(options.metadata);
	const providerCode = sanitizeProviderCode(options.providerCode);

	if (options.skin === "anthropic") {
		return {
			type: "error",
			error: {
				type: ANTHROPIC_TYPE_BY_ERROR_TYPE[options.errorType],
				message,
				error_type: options.errorType,
			},
			request_id: options.requestId ?? null,
			...(options.legacyCode ? { code: options.legacyCode } : {}),
		};
	}

	if (options.skin === "responses") {
		return {
			status: "failed",
			error: {
				code: RESPONSE_CODE_BY_ERROR_TYPE[options.errorType],
				message,
			},
			error_type: options.errorType,
			...(options.requestId ? { id: options.requestId } : {}),
			...(options.legacyCode ? { code: options.legacyCode } : {}),
		};
	}

	return {
		error: {
			code: options.status,
			message,
			metadata: {
				...metadata,
				error_type: options.errorType,
				...(providerCode ? { provider_code: providerCode } : {}),
			},
		},
		...(options.legacyCode ? { code: options.legacyCode } : {}),
	};
}

export type UpstreamErrorDetails = {
	message: string | null;
	providerCode: string | null;
};

export function extractUpstreamErrorDetails(
	bodyText: string
): UpstreamErrorDetails {
	try {
		const parsed = JSON.parse(bodyText) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return {
				message:
					typeof parsed === "string"
						? sanitizePublicErrorMessage(parsed)
						: null,
				providerCode: null,
			};
		}
		const record = parsed as Record<string, unknown>;
		const nested =
			record.error &&
			typeof record.error === "object" &&
			!Array.isArray(record.error)
				? (record.error as Record<string, unknown>)
				: null;
		const nestedString = typeof record.error === "string" ? record.error : null;
		const rawMessage =
			nested?.message ??
			record.message ??
			record.detail ??
			record.error_description ??
			nestedString;
		const rawCode = nested?.code ?? nested?.type ?? record.code ?? record.type;
		return {
			message:
				typeof rawMessage === "string"
					? sanitizePublicErrorMessage(rawMessage)
					: null,
			providerCode: sanitizeProviderCode(rawCode),
		};
	} catch {
		const message = collapseWhitespace(bodyText);
		return {
			message: message ? sanitizePublicErrorMessage(message) : null,
			providerCode: null,
		};
	}
}

function typedErrorFromProviderCode(
	providerCode: string | null
): OpenRouterErrorType | null {
	if (!providerCode) return null;
	const code = providerCode.toLowerCase();
	if (code.includes("context_length")) return "context_length_exceeded";
	if (code.includes("max_tokens")) return "max_tokens_exceeded";
	if (code.includes("token_limit")) return "token_limit_exceeded";
	if (code.includes("string_too_long")) return "string_too_long";
	if (code.includes("invalid_prompt")) return "invalid_prompt";
	if (code.includes("payload_too_large") || code.includes("request_too_large"))
		return "payload_too_large";
	return null;
}

export function openRouterErrorTypeForUpstream(params: {
	status: number;
	legacyCode: GatewayErrorCodeValue;
	providerCode?: string | null;
}): OpenRouterErrorType {
	const typed = typedErrorFromProviderCode(params.providerCode ?? null);
	if (typed) return typed;
	if (params.status === 413) return "payload_too_large";
	if (params.status === 422) return "unprocessable";
	if (params.status === 408 || params.status === 504 || params.status === 524)
		return "timeout";
	if (params.status === 429) return "rate_limit_exceeded";
	if (params.status === 529) return "provider_overloaded";
	if (params.legacyCode === GatewayErrorCode.upstreamContentFilter)
		return "content_policy_violation";
	if (params.status === 400) return "invalid_request";
	// A provider's auth/not-found/server error is a gateway availability failure,
	// not an instruction for the caller to replace their valid CinaToken key.
	return "provider_unavailable";
}

export function publicMessageForGatewayError(
	code: GatewayErrorCodeValue,
	message: string
): string {
	switch (code) {
		case GatewayErrorCode.internalError:
			return "Internal server error";
		case GatewayErrorCode.noRoute:
		case GatewayErrorCode.zdrNoRoute:
		case GatewayErrorCode.dataCollectionNoRoute:
			return "No available model provider meets the routing requirements";
		case GatewayErrorCode.routeResolutionFailed:
		case GatewayErrorCode.upstreamRequestFailed:
		case GatewayErrorCode.upstreamAuthFailed:
		case GatewayErrorCode.upstreamNotFound:
		case GatewayErrorCode.upstreamServerError:
			return "Upstream provider is unavailable";
		case GatewayErrorCode.upstreamTimeout:
			return "Upstream provider timed out";
		default:
			return sanitizePublicErrorMessage(message);
	}
}

export function buildChatMidstreamErrorEvent(params: {
	model: string;
	provider: string;
	/** Reuse the request/stream association id. Never mint an unrelated id mid-stream. */
	id?: string | null;
	message?: string;
}): string {
	const status = openRouterStatusForErrorType("provider_unavailable");
	return `data: ${JSON.stringify({
		...(params.id ? { id: params.id } : {}),
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model: params.model,
		provider: params.provider,
		error: {
			code: status,
			message: sanitizePublicErrorMessage(
				params.message ?? "Upstream provider stream interrupted"
			),
			metadata: { error_type: "provider_unavailable" },
		},
		choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }],
	})}\n\n`;
}

export function buildAnthropicMidstreamErrorEvent(params?: {
	message?: string;
	/** Post-router generation/message association id, when one is already known. */
	requestId?: string | null;
}): string {
	return `event: error\ndata: ${JSON.stringify({
		type: "error",
		error: {
			type: "api_error",
			message: sanitizePublicErrorMessage(
				params?.message ?? "Upstream provider stream interrupted"
			),
			error_type: "provider_unavailable",
		},
		...(params?.requestId ? { request_id: params.requestId } : {}),
	})}\n\n`;
}

export function buildResponsesFailedEvent(params?: {
	/** Reuse the current response/generation association id. Never mint a second id. */
	id?: string | null;
	model?: string;
	message?: string;
}): string {
	return `event: response.failed\ndata: ${JSON.stringify({
		type: "response.failed",
		response: {
			...(params?.id ? { id: params.id } : {}),
			object: "response",
			created_at: Math.floor(Date.now() / 1000),
			status: "failed",
			error: {
				code: "server_error",
				message: sanitizePublicErrorMessage(
					params?.message ?? "Upstream provider stream interrupted"
				),
			},
			error_type: "provider_unavailable",
			...(params?.model ? { model: params.model } : {}),
		},
	})}\n\n`;
}
