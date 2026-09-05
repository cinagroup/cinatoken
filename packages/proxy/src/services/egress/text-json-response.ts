import type { ProxyDispatchMeta } from '../failover-dispatch';
import { GATEWAY_ERROR_CODE_HEADER, GatewayErrorCode } from '../gateway-error-codes';
import { gatewayErrorResponse } from '../gateway-error-response';
import {
	buildOpenRouterErrorBody,
	type OpenRouterErrorSkin,
} from '../openrouter-error-protocol';
import {
	responseTextWithinLimit,
	UpstreamResponseBodyTooLargeError,
} from './bounded-response-body';

/**
 * A non-streaming text completion is materialized at most once. Eight MiB is
 * intentionally below the Worker isolate memory ceiling because parsing and
 * re-serializing JSON temporarily retain more than one representation.
 */
export const TEXT_JSON_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
/** Prevent adversarially dense arrays from turning schema checks into long CPU loops. */
export const TEXT_SUCCESS_RESPONSE_MAX_COLLECTION_ITEMS = 4_096;

export type BoundedTextJsonObjectResult =
	| { ok: true; value: Record<string, unknown> }
	| { ok: false; response: Response; meta: ProxyDispatchMeta };

export type TextSuccessProtocol = 'Chat Completions' | 'Responses' | 'Anthropic Messages' | 'Rerank';

/**
 * Replace an accepted but protocol-invalid provider response with one fixed,
 * non-replayable error. A 2xx means the provider may already have generated
 * and billed work even when its body cannot be trusted.
 */
export function invalidTextSuccessResponse(params: {
	skin: OpenRouterErrorSkin;
	protocol: TextSuccessProtocol;
	requestId?: string | null;
}): { response: Response; meta: ProxyDispatchMeta } {
	return {
		response: gatewayErrorResponse({
			status: 502,
			code: GatewayErrorCode.upstreamRequestFailed,
			message: `Upstream provider returned an invalid ${params.protocol} response`,
			skin: params.skin,
			requestId: params.requestId,
		}),
		meta: {
			upstreamOutcomeUnknown: true,
			failoverForbidden: true,
			gatewayGeneratedError: true,
		},
	};
}

/** Cancel an unread accepted body before returning the fixed protocol error. */
export async function cancelInvalidTextSuccessResponse(
	response: Response,
	params: {
		skin: OpenRouterErrorSkin;
		protocol: TextSuccessProtocol;
		requestId?: string | null;
	},
): Promise<{ response: Response; meta: ProxyDispatchMeta }> {
	await response.body?.cancel('invalid_text_success_response').catch(() => undefined);
	return invalidTextSuccessResponse(params);
}

function unreadableTextJsonResponse(params: {
	skin: OpenRouterErrorSkin;
	requestId?: string | null;
	tooLarge: boolean;
}): { response: Response; meta: ProxyDispatchMeta } {
	return {
		response: gatewayErrorResponse({
			status: 502,
			code: params.tooLarge
				? GatewayErrorCode.upstreamResponseTooLarge
				: GatewayErrorCode.upstreamRequestFailed,
			message: params.tooLarge
				? 'Upstream response exceeded the gateway size limit'
				: 'Upstream provider returned an invalid JSON response',
			skin: params.skin,
			requestId: params.requestId,
		}),
		meta: {
			upstreamOutcomeUnknown: true,
			failoverForbidden: true,
			gatewayGeneratedError: true,
			...(params.tooLarge ? { responseBodyTooLarge: true } : {}),
		},
	};
}

/** Read and parse one accepted JSON response without retaining an unbounded body. */
export async function readBoundedTextJsonObject(
	response: Response,
	options: {
		skin: OpenRouterErrorSkin;
		requestId?: string | null;
		maxBytes?: number;
	},
): Promise<BoundedTextJsonObjectResult> {
	let text: string;
	try {
		text = await responseTextWithinLimit(
			response,
			options.maxBytes ?? TEXT_JSON_RESPONSE_MAX_BYTES,
		);
	} catch (error) {
		return {
			ok: false,
			...unreadableTextJsonResponse({
				...options,
				tooLarge: error instanceof UpstreamResponseBodyTooLargeError,
			}),
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch {
		return {
			ok: false,
			...unreadableTextJsonResponse({ ...options, tooLarge: false }),
		};
	}
	if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return {
			ok: false,
			...unreadableTextJsonResponse({ ...options, tooLarge: false }),
		};
	}
	return { ok: true, value: parsed as Record<string, unknown> };
}

/** Rebuild a consumed JSON response so the caller always receives a readable body. */
export function rebuildTextJsonResponse(
	response: Response,
	value: Record<string, unknown>,
): Response {
	const headers = new Headers(response.headers);
	headers.delete('Content-Length');
	headers.delete('Content-Encoding');
	headers.delete('Transfer-Encoding');
	return new Response(JSON.stringify(value), {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

/** A request cancelled before admission is known not to have reached a provider. */
export function preDispatchCancelledTextResponse(
	skin: OpenRouterErrorSkin,
	requestId?: string | null,
): Response {
	const status = 499;
	return new Response(JSON.stringify(buildOpenRouterErrorBody({
		skin,
		status,
		message: 'Request was cancelled before upstream dispatch',
		errorType: 'provider_unavailable',
		legacyCode: GatewayErrorCode.upstreamRequestFailed,
		requestId,
	})), {
		status,
		headers: {
			'Content-Type': 'application/json; charset=UTF-8',
			'Cache-Control': 'no-store',
			[GATEWAY_ERROR_CODE_HEADER]: GatewayErrorCode.upstreamRequestFailed,
		},
	});
}
