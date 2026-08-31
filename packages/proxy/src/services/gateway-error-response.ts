/**
 * Public gateway errors use OpenRouter's stable nested envelope while retaining
 * the historical dotted code in a top-level compatibility field and response
 * header. Provider/runtime details are sanitized before serialization.
 */
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
	GATEWAY_ERROR_CODE_HEADER,
	type GatewayErrorCodeValue,
} from './gateway-error-codes';
import {
	buildOpenRouterErrorBody,
	inferOpenRouterErrorSkin,
	openRouterErrorTypeForGatewayCode,
	openRouterStatusForGatewayCode,
	publicMessageForGatewayError,
	type OpenRouterErrorSkin,
} from './openrouter-error-protocol';
export {
	classifyUpstreamErrorCode,
	withUpstreamErrorCodeHeader,
} from './upstream-error-code';

export type GatewayErrorJsonOptions = {
	/** Kept at call sites as an assertion of intent; the public status is canonicalized from `code`. */
	status: ContentfulStatusCode;
	code: GatewayErrorCodeValue;
	message: string;
	headers?: Record<string, string>;
	metadata?: Record<string, unknown>;
	skin?: OpenRouterErrorSkin;
	requestId?: string | null;
};

function publicErrorHeaders(
	code: GatewayErrorCodeValue,
	status: number,
	extra?: Record<string, string>,
): Headers {
	const headers = new Headers(extra);
	headers.set('Content-Type', 'application/json; charset=UTF-8');
	headers.set('Cache-Control', 'no-store');
	headers.set(GATEWAY_ERROR_CODE_HEADER, code);
	headers.delete('Content-Length');
	// OpenRouter only publishes Retry-After for rate limits and temporary
	// availability failures. Avoid stale/misleading retry hints on other errors.
	if (status !== 429 && status !== 503 && status !== 529) headers.delete('Retry-After');
	return headers;
}

function buildGatewayErrorResponse(
	opts: GatewayErrorJsonOptions,
	skin: OpenRouterErrorSkin,
): Response {
	const status = openRouterStatusForGatewayCode(opts.code);
	const errorType = openRouterErrorTypeForGatewayCode(opts.code);
	const message = publicMessageForGatewayError(opts.code, opts.message);
	const body = buildOpenRouterErrorBody({
		skin,
		status,
		message,
		errorType,
		legacyCode: opts.code,
		metadata: opts.metadata,
		requestId: opts.requestId,
	});
	return new Response(JSON.stringify(body), {
		status,
		headers: publicErrorHeaders(opts.code, status, opts.headers),
	});
}

/** Hono context: Anthropic Messages gets its native skin; all other request-stage errors use OpenRouter's envelope. */
export function gatewayErrorJson(c: Context, opts: GatewayErrorJsonOptions): Response {
	const skin = opts.skin ?? inferOpenRouterErrorSkin(c.req.path);
	const contextGenerationId = (c.var as Record<string, unknown>).generationId;
	return buildGatewayErrorResponse({
		...opts,
		requestId: opts.requestId !== undefined
			? opts.requestId
			: skin === 'anthropic' && typeof contextGenerationId === 'string'
				? contextGenerationId
				: undefined,
	}, skin);
}

/** Non-Hono paths default to the canonical OpenRouter/Chat error envelope. */
export function gatewayErrorResponse(opts: GatewayErrorJsonOptions): Response {
	return buildGatewayErrorResponse(opts, opts.skin ?? 'chat');
}

/** Compatibility entry point for circuit responses that previously supplied a nested error object. */
export function gatewayNestedErrorResponse(opts: {
	status: number;
	code: GatewayErrorCodeValue;
	error: Record<string, unknown>;
	headers?: Record<string, string>;
	skin?: OpenRouterErrorSkin;
	requestId?: string | null;
}): Response {
	const rawMessage = typeof opts.error.message === 'string' ? opts.error.message : 'Request failed';
	const metadata: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(opts.error)) {
		if (key === 'message' || key === 'code') continue;
		metadata[key === 'type' ? 'reason' : key] = value;
	}
	return buildGatewayErrorResponse({
		status: opts.status as ContentfulStatusCode,
		code: opts.code,
		message: rawMessage,
		headers: opts.headers,
		metadata,
		skin: opts.skin,
		requestId: opts.requestId,
	}, opts.skin ?? 'chat');
}
