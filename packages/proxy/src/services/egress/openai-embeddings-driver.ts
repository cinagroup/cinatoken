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
import { GatewayErrorCode } from '../gateway-error-codes';
import { gatewayErrorResponse } from '../gateway-error-response';
import { markUpstreamOutcomeUnknown } from '../failover-dispatch';
import { extractUpstreamRequestId, normalizeUpstreamId } from './upstream-request-id';
import { assertTextUpstreamHttpUrl } from './text-upstream-url';
import {
	preDispatchCancelledTextResponse,
	readBoundedTextJsonObject,
	rebuildTextJsonResponse,
} from './text-json-response';

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
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
		? value
		: -1;
}

/** Normalize OpenAI-compatible embedding usage onto the gateway token ledger. */
export function usageFromEmbeddings(raw: EmbeddingsUsage): UsageFromStream {
	const promptTokens = raw.prompt_tokens === undefined
		? null
		: nonNegativeCount(raw.prompt_tokens);
	const inputAliasTokens = raw.input_tokens === undefined
		? null
		: nonNegativeCount(raw.input_tokens);
	const totalTokens = nonNegativeCount(raw.total_tokens);
	const inputTokens = promptTokens ?? inputAliasTokens;
	if (
		inputTokens == null
		|| inputTokens < 0
		|| totalTokens < inputTokens
		|| (promptTokens != null && inputAliasTokens != null && promptTokens !== inputAliasTokens)
	) {
		return { ...EMPTY_USAGE_LOCAL };
	}
	return {
		input_tokens: inputTokens,
		output_tokens: 0,
		cache_read_tokens: 0,
		cache_write_tokens: 0,
		reasoning_tokens: 0,
		total_tokens: totalTokens,
		raw_usage: JSON.stringify(raw),
		native_tokens_prompt: inputTokens,
		native_tokens_completion: 0,
		native_tokens_cached: null,
		native_tokens_reasoning: null,
		native_tokens_completion_images: null,
	};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function expectedEmbeddingCount(input: unknown): number | null {
	if (typeof input === 'string' && input.length > 0) return 1;
	if (!Array.isArray(input) || input.length === 0) return null;
	if (input.every((item) => typeof item === 'number' && Number.isFinite(item))) return 1;
	return input.length;
}

function validBase64(value: string): boolean {
	if (value.length === 0 || value.length % 4 !== 0) return false;
	let padding = 0;
	if (value.endsWith('==')) padding = 2;
	else if (value.endsWith('=')) padding = 1;
	const dataEnd = value.length - padding;
	for (let index = 0; index < dataEnd; index += 1) {
		const code = value.charCodeAt(index);
		const alphaNumeric = (code >= 48 && code <= 57)
			|| (code >= 65 && code <= 90)
			|| (code >= 97 && code <= 122);
		if (!alphaNumeric && code !== 43 && code !== 47) return false;
	}
	for (let index = dataEnd; index < value.length; index += 1) {
		if (value.charCodeAt(index) !== 61) return false;
	}
	if (padding === 0) return true;
	return padding === 2 ? dataEnd % 4 === 2 : dataEnd % 4 === 3;
}

function validEmbeddingValue(value: unknown, encodingFormat: 'float' | 'base64'): boolean {
	if (encodingFormat === 'base64') return typeof value === 'string' && validBase64(value);
	return Array.isArray(value)
		&& value.length > 0
		&& value.every((item) => typeof item === 'number' && Number.isFinite(item));
}

function validEmbeddingData(
	value: unknown,
	expectedCount: number,
	encodingFormat: 'float' | 'base64',
): boolean {
	if (!Array.isArray(value) || value.length !== expectedCount) return false;
	const indexes = new Set<number>();
	for (const item of value) {
		if (!isPlainObject(item) || item.object !== 'embedding') return false;
		if (
			typeof item.index !== 'number'
			|| !Number.isSafeInteger(item.index)
			|| item.index < 0
			|| item.index >= expectedCount
			|| indexes.has(item.index)
			|| !validEmbeddingValue(item.embedding, encodingFormat)
		) return false;
		indexes.add(item.index);
	}
	return indexes.size === expectedCount;
}

function invalidEmbeddingSuccess(requestId?: string): {
	response: Response;
	usagePromise: Promise<UsageFromStream>;
	meta: ProxyDispatchMeta;
} {
	return {
		response: gatewayErrorResponse({
			status: 502,
			code: GatewayErrorCode.upstreamRequestFailed,
			message: 'Upstream provider returned an invalid embeddings response',
			requestId,
		}),
		usagePromise: Promise.resolve({ ...EMPTY_USAGE_LOCAL }),
		meta: {
			upstreamOutcomeUnknown: true,
			failoverForbidden: true,
			gatewayGeneratedError: true,
		},
	};
}

async function normalizeSuccessfulEmbeddingsResponse(
	response: Response,
	requestBody: Record<string, unknown>,
	publicModelId: string | undefined,
	publicCorrelationId?: string,
	timing?: RequestTimingCollector | null,
): Promise<{
	response: Response;
	usagePromise: Promise<UsageFromStream>;
	meta?: ProxyDispatchMeta;
}> {
	const contentType = response.headers.get('Content-Type') ?? '';
	if (!contentType.toLowerCase().includes('application/json')) {
		await response.body?.cancel('invalid_embeddings_content_type').catch(() => undefined);
		timing?.markStreamComplete();
		return invalidEmbeddingSuccess(publicCorrelationId);
	}

	const materialized = await readBoundedTextJsonObject(response, {
		skin: 'chat',
		requestId: publicCorrelationId,
		maxBytes: OPENAI_EMBEDDINGS_RESPONSE_MAX_BYTES,
	});
	timing?.markStreamComplete();
	if (!materialized.ok) {
		return {
			response: materialized.response,
			usagePromise: Promise.resolve({ ...EMPTY_USAGE_LOCAL }),
			meta: materialized.meta,
		};
	}

	const object = materialized.value;
	const inputCount = expectedEmbeddingCount(requestBody.input);
	const encodingFormat = requestBody.encoding_format === 'base64' ? 'base64' : 'float';
	const nativeId = object.id === undefined ? null : normalizeUpstreamId(object.id);
	if (
		inputCount == null
		|| object.object !== 'list'
		|| typeof object.model !== 'string'
		|| !object.model.trim()
		|| !validEmbeddingData(object.data, inputCount, encodingFormat)
		|| (object.id !== undefined && nativeId == null)
	) return invalidEmbeddingSuccess(publicCorrelationId);

	const usageRaw = object.usage;
	let usage: UsageFromStream = { ...EMPTY_USAGE_LOCAL };
	if (usageRaw !== undefined) {
		if (!isPlainObject(usageRaw)) return invalidEmbeddingSuccess(publicCorrelationId);
		usage = usageFromEmbeddings(usageRaw as EmbeddingsUsage);
		if (usage.raw_usage == null) return invalidEmbeddingSuccess(publicCorrelationId);
	}
	if (nativeId) usage = { ...usage, upstreamMessageId: nativeId };
	if (publicModelId) object.model = publicModelId;
	return {
		response: rebuildTextJsonResponse(response, object),
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
	publicCorrelationId?: string,
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
	const cancelledBeforeDispatch = () => ({
		response: preDispatchCancelledTextResponse('chat', publicCorrelationId),
		usagePromise: Promise.resolve({ ...EMPTY_USAGE_LOCAL, cancelled: true }),
		upstreamRequestId: null,
		meta: {
			failoverForbidden: true,
			gatewayGeneratedError: true,
		} satisfies ProxyDispatchMeta,
	});
	if (requestSignal?.aborted) return cancelledBeforeDispatch();
	const { secret } = await resolveProviderUpstreamSecret(route.providerApiKey);
	const requestBody = {
		...buildRouteRequestBody(route, body),
		model: applyVertexOpenAiModelPrefix(url, route.providerModelName),
	};
	const serializedBody = JSON.stringify(requestBody);
	const headers = {
		'Content-Type': 'application/json',
		Authorization: `Bearer ${secret}`,
	};
	new Headers(headers);

	if (requestSignal?.aborted) return cancelledBeforeDispatch();
	await beforeFetch?.();
	if (requestSignal?.aborted) return cancelledBeforeDispatch();
	let response: Response;
	try {
		response = await fetch(url, {
			method: 'POST',
			headers,
			body: serializedBody,
			signal: requestSignal,
		});
	} catch (error) {
		throw markUpstreamOutcomeUnknown(error);
	}
	timing?.markAttemptHeaders(attempt, response.status);
	const upstreamRequestId = extractUpstreamRequestId(response.headers);
	if (!response.ok) {
		return {
			response,
			usagePromise: Promise.resolve({ ...EMPTY_USAGE_LOCAL }),
			upstreamRequestId,
		};
	}
	const normalized = await normalizeSuccessfulEmbeddingsResponse(
		response,
		requestBody,
		route.gatewayModelId,
		publicCorrelationId,
		timing,
	);
	return { ...normalized, upstreamRequestId };
}
