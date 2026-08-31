/**
 * 上游非 2xx → 有界读取、公开错误规范化与 `upstream.*` 兼容分类。
 */
import {
	GATEWAY_ERROR_CODE_HEADER,
	GatewayErrorCode,
	type GatewayErrorCodeValue,
} from './gateway-error-codes';
import { classifyUpstreamHttpFailure } from './upstream-failure-classifier';
import { isSensitiveContentErrorMessage } from './sensitive-content-detector';
import {
	buildOpenRouterErrorBody,
	extractUpstreamErrorDetails,
	openRouterErrorTypeForUpstream,
	openRouterStatusForErrorType,
	sanitizePublicErrorMessage,
	type OpenRouterErrorSkin,
} from './openrouter-error-protocol';

export function classifyUpstreamErrorCode(
	status: number,
	_contentType: string | null,
	bodyText: string
): GatewayErrorCodeValue {
	if (status === 524) {
		return GatewayErrorCode.upstreamTimeout;
	}
	const classification = classifyUpstreamHttpFailure(status);
	if (classification.failureKind === 'rate_limit') {
		return GatewayErrorCode.upstreamRateLimited;
	}
	if (classification.failureKind === 'auth') {
		return GatewayErrorCode.upstreamAuthFailed;
	}
	if (classification.failureKind === 'server') {
		return GatewayErrorCode.upstreamServerError;
	}
	if (status === 404) {
		return GatewayErrorCode.upstreamNotFound;
	}
	if (status === 400) {
		if (isSensitiveContentErrorMessage(bodyText)) {
			return GatewayErrorCode.upstreamContentFilter;
		}
		return GatewayErrorCode.upstreamInvalidRequest;
	}
	if (status >= 500) {
		return GatewayErrorCode.upstreamServerError;
	}
	return GatewayErrorCode.upstreamInvalidRequest;
}

function publicUpstreamMessage(
	errorType: ReturnType<typeof openRouterErrorTypeForUpstream>,
	upstreamMessage: string | null,
): string {
	switch (errorType) {
		case 'provider_unavailable':
			return 'Upstream provider is unavailable';
		case 'provider_overloaded':
			return 'Upstream provider is temporarily overloaded';
		case 'timeout':
			return 'Upstream provider timed out';
		case 'server':
		case 'unmapped':
			return 'Internal server error';
		default:
			return sanitizePublicErrorMessage(upstreamMessage ?? 'Upstream request failed');
	}
}

/**
 * Normalize a bounded upstream error into the public OpenRouter contract.
 * Only Retry-After is copied from the provider; raw provider headers and
 * 5xx/auth/not-found details are intentionally not exposed.
 */
export function withUpstreamErrorCodeHeader(
	response: Response,
	errorBodyText: string,
	skin: OpenRouterErrorSkin = 'chat',
	requestId?: string | null,
): Response {
	const code = classifyUpstreamErrorCode(
		response.status,
		response.headers.get('content-type'),
		errorBodyText
	);
	const details = extractUpstreamErrorDetails(errorBodyText);
	const errorType = openRouterErrorTypeForUpstream({
		status: response.status,
		legacyCode: code,
		providerCode: details.providerCode,
	});
	// OpenRouter reserves 529 for provider overload. An upstream HTTP 503 is a
	// service-unavailable response, so preserve it (and its Retry-After) while
	// classifying the public error as provider_unavailable rather than overloaded.
	const status = response.status === 503 && errorType === 'provider_unavailable'
		? 503
		: openRouterStatusForErrorType(errorType);
	const message = publicUpstreamMessage(errorType, details.message);
	const body = buildOpenRouterErrorBody({
		skin,
		status,
		message,
		errorType,
		legacyCode: code,
		providerCode: status < 500 ? details.providerCode : null,
		requestId,
	});
	const headers = new Headers({
		'Content-Type': 'application/json; charset=UTF-8',
		'Cache-Control': 'no-store',
	});
	headers.set(GATEWAY_ERROR_CODE_HEADER, code);
	if (status === 429 || status === 503 || status === 529) {
		const retryAfter = response.headers.get('Retry-After');
		if (retryAfter && retryAfter.length <= 128) headers.set('Retry-After', retryAfter);
	}
	return new Response(JSON.stringify(body), {
		status,
		headers,
	});
}
