import {
	applyVertexOpenAiModelPrefix,
	resolveProviderUpstreamSecret,
	resolveUpstreamEndpoint,
} from '@octafuse/core';
import type { RouteResult } from '../model-router';
import type { ProxyDispatchMeta } from '../failover-dispatch';
import type { UsageFromStream } from '../proxy';
import { buildRouteRequestBody } from '../route-default-params';
import type { RequestTimingAttempt, RequestTimingCollector } from '../request-timing';
import { GATEWAY_ERROR_CODE_HEADER, GatewayErrorCode } from '../gateway-error-codes';
import { gatewayErrorResponse } from '../gateway-error-response';
import { markUpstreamOutcomeUnknown } from '../failover-dispatch';
import { extractUpstreamRequestId, normalizeUpstreamId } from './upstream-request-id';
import {
	responseTextWithinLimit,
	UpstreamResponseBodyTooLargeError,
} from './bounded-response-body';
import { assertTextUpstreamHttpUrl } from './text-upstream-url';

/** Large enough for sizeable float vectors while remaining bounded inside a Worker isolate. */
export const OPENAI_EMBEDDINGS_RESPONSE_MAX_BYTES = 32 * 1024 * 1024;

const EMPTY_USAGE_LOCAL: UsageFromStream = {
	input_tokens: 0,
	output_tokens: 0,
	cache_read_tokens: 0,
	cache_write_tokens: 0,
	reasoning_tokens: 0,
	total_tokens: 0,
	raw_usage: null,
};

type EmbeddingsUsage = {
	prompt_tokens?: unknown;
	input_tokens?: unknown;
	total_tokens?: unknown;
};

function nonNegativeCount(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0
		? Math.trunc(value)
		: 0;
}

/** Normalize OpenAI-compatible embedding usage onto the gateway token ledger. */
export function usageFromEmbeddings(raw: EmbeddingsUsage): UsageFromStream {
	const inputTokens = nonNegativeCount(raw.prompt_tokens ?? raw.input_tokens);
	const totalTokens = nonNegativeCount(raw.total_tokens) || inputTokens;
	return {
		input_tokens: inputTokens,
		output_tokens: 0,
		cache_read_tokens: 0,
		cache_write_tokens: 0,
		reasoning_tokens: 0,
		total_tokens: totalTokens,
		raw_usage: JSON.stringify(raw),
	};
}

function rebuildJsonResponse(response: Response, text: string): Response {
	const headers = new Headers(response.headers);
	headers.delete('Content-Length');
	return new Response(text, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

function unreadableEmbeddingResponse(message: string): Response {
	return gatewayErrorResponse({
		status: 502,
		code: GatewayErrorCode.upstreamRequestFailed,
		message,
	});
}

async function normalizeSuccessfulEmbeddingsResponse(
	response: Response,
	publicModelId: string | undefined,
	timing?: RequestTimingCollector | null,
): Promise<{
	response: Response;
	usagePromise: Promise<UsageFromStream>;
	meta?: ProxyDispatchMeta;
}> {
	const contentType = response.headers.get('Content-Type') ?? '';
	if (!contentType.toLowerCase().includes('application/json')) {
		// Keep an unexpected body streaming and account it conservatively as missing usage.
		timing?.markStreamComplete();
		return { response, usagePromise: Promise.resolve({ ...EMPTY_USAGE_LOCAL }) };
	}

	let text: string;
	try {
		text = await responseTextWithinLimit(response, OPENAI_EMBEDDINGS_RESPONSE_MAX_BYTES);
	} catch (error) {
		timing?.markStreamComplete();
		if (error instanceof UpstreamResponseBodyTooLargeError) {
			return {
				response: unreadableEmbeddingResponse('Upstream embeddings response exceeded the gateway size limit'),
				usagePromise: Promise.resolve({ ...EMPTY_USAGE_LOCAL }),
				meta: { responseBodyTooLarge: true, failoverForbidden: true },
			};
		}
		return {
			response: unreadableEmbeddingResponse('Upstream embeddings response could not be read'),
			usagePromise: Promise.resolve({ ...EMPTY_USAGE_LOCAL }),
			meta: { upstreamOutcomeUnknown: true, failoverForbidden: true },
		};
	}

	timing?.markStreamComplete();
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch {
		return {
			response: rebuildJsonResponse(response, text),
			usagePromise: Promise.resolve({ ...EMPTY_USAGE_LOCAL }),
		};
	}
	if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return {
			response: rebuildJsonResponse(response, text),
			usagePromise: Promise.resolve({ ...EMPTY_USAGE_LOCAL }),
		};
	}

	const object = parsed as Record<string, unknown>;
	if (publicModelId) object.model = publicModelId;
	const usageRaw = object.usage;
	let usage: UsageFromStream = { ...EMPTY_USAGE_LOCAL };
	if (usageRaw != null && typeof usageRaw === 'object' && !Array.isArray(usageRaw)) {
		usage = usageFromEmbeddings(usageRaw as EmbeddingsUsage);
	}
	const messageId = normalizeUpstreamId(object.id);
	if (messageId) usage = { ...usage, upstreamMessageId: messageId };
	return {
		response: rebuildJsonResponse(response, JSON.stringify(object)),
		usagePromise: Promise.resolve(usage),
	};
}

/** Dispatch one OpenAI-compatible embeddings attempt and capture its input-token usage. */
export async function dispatchOpenAiEmbeddingsRoute(
	route: RouteResult,
	body: Record<string, unknown>,
	requestSignal?: AbortSignal,
	timing?: RequestTimingCollector | null,
	attempt?: RequestTimingAttempt,
	beforeFetch?: () => Promise<void>,
): Promise<{
	response: Response;
	usagePromise: Promise<UsageFromStream>;
	upstreamRequestId: string | null;
	meta?: ProxyDispatchMeta;
}> {
	const url = resolveUpstreamEndpoint('openai', 'embeddings', route.providerEndpoints, {
		providerId: route.providerId,
	});
	assertTextUpstreamHttpUrl(url);
	const { secret } = await resolveProviderUpstreamSecret(route.providerApiKey);
	const requestBody = {
		...buildRouteRequestBody(route, body),
		model: applyVertexOpenAiModelPrefix(url, route.providerModelName),
	};
	const serializedBody = JSON.stringify(requestBody);

	await beforeFetch?.();
	let response: Response;
	try {
		response = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${secret}`,
			},
			body: serializedBody,
			signal: requestSignal,
		});
	} catch (error) {
		if (requestSignal?.aborted) {
			return {
				response: new Response(JSON.stringify({
					error: 'Client disconnected before the embeddings response completed',
					code: GatewayErrorCode.upstreamRequestFailed,
				}), {
					status: 499,
					headers: {
						'Content-Type': 'application/json',
						[GATEWAY_ERROR_CODE_HEADER]: GatewayErrorCode.upstreamRequestFailed,
					},
				}),
				usagePromise: Promise.resolve({ ...EMPTY_USAGE_LOCAL, cancelled: true }),
				upstreamRequestId: null,
				meta: { upstreamOutcomeUnknown: true, failoverForbidden: true },
			};
		}
		throw markUpstreamOutcomeUnknown(error);
	}
	timing?.markAttemptHeaders(attempt, response.status);
	const upstreamRequestId = extractUpstreamRequestId(response.headers);
	if (!response.ok || !response.body) {
		return {
			response,
			usagePromise: Promise.resolve({ ...EMPTY_USAGE_LOCAL }),
			upstreamRequestId,
		};
	}
	const normalized = await normalizeSuccessfulEmbeddingsResponse(
		response,
		route.gatewayModelId,
		timing,
	);
	return { ...normalized, upstreamRequestId };
}
