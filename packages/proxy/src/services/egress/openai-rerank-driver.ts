import {
	applyVertexOpenAiModelPrefix,
	resolveProviderUpstreamSecret,
	resolveUpstreamEndpoint,
} from '@octafuse/core';
import type { ProxyDispatchMeta } from '../failover-dispatch';
import { markUpstreamOutcomeUnknown } from '../failover-dispatch';
import type { RouteResult } from '../model-router';
import type { UsageFromStream } from '../proxy';
import { buildRouteRequestBody } from '../route-default-params';
import type { RequestTimingAttempt, RequestTimingCollector } from '../request-timing';
import { extractUpstreamRequestId, normalizeUpstreamId } from './upstream-request-id';
import { assertTextUpstreamHttpUrl } from './text-upstream-url';
import {
	cancelInvalidTextSuccessResponse,
	invalidTextSuccessResponse,
	preDispatchCancelledTextResponse,
	readBoundedTextJsonObject,
	rebuildTextJsonResponse,
} from './text-json-response';

/** Bounded above the ingress limit while leaving room for response metadata. */
export const OPENAI_RERANK_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;

const EMPTY_USAGE_LOCAL: UsageFromStream = {
	input_tokens: 0,
	output_tokens: 0,
	cache_read_tokens: 0,
	cache_write_tokens: 0,
	reasoning_tokens: 0,
	total_tokens: 0,
	raw_usage: null,
};

type RerankUsage = {
	search_units?: unknown;
	total_tokens?: unknown;
	cost?: unknown;
};

function normalizedRerankUsage(raw: RerankUsage): Record<string, number> | null {
	const allowed = new Set(['search_units', 'total_tokens', 'cost']);
	if (Object.keys(raw).some((key) => !allowed.has(key))) return null;
	const normalized: Record<string, number> = {};
	if (raw.search_units !== undefined) {
		const value = nonNegativeSafeInteger(raw.search_units);
		if (value == null) return null;
		normalized.search_units = value;
	}
	if (raw.total_tokens !== undefined) {
		const value = nonNegativeSafeInteger(raw.total_tokens);
		if (value == null) return null;
		normalized.total_tokens = value;
	}
	if (raw.cost !== undefined) {
		const value = nonNegativeFiniteNumber(raw.cost);
		if (value == null) return null;
		normalized.cost = value;
	}
	return normalized;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function nonNegativeSafeInteger(value: unknown): number | null {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
		? value
		: null;
}

function nonNegativeFiniteNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0
		? value
		: null;
}

/** Validate and normalize only the documented usage counters. */
export function usageFromRerank(raw: RerankUsage): UsageFromStream | null {
	const normalized = normalizedRerankUsage(raw);
	if (!normalized) return null;
	const totalTokens = normalized.total_tokens ?? 0;
	return {
		input_tokens: totalTokens,
		output_tokens: 0,
		cache_read_tokens: 0,
		cache_write_tokens: 0,
		reasoning_tokens: 0,
		total_tokens: totalTokens,
		// Search units are part of the public contract, but the current ledger has no
		// independent search-unit meter. Without total_tokens, keep settlement
		// conservative by treating the accepted response usage as non-authoritative.
		raw_usage: raw.total_tokens === undefined ? null : JSON.stringify(normalized),
		native_tokens_prompt: raw.total_tokens === undefined ? null : totalTokens,
		native_tokens_completion: 0,
		native_tokens_cached: null,
		native_tokens_reasoning: null,
		native_tokens_completion_images: null,
	};
}

function reconstructedDocument(value: unknown): Record<string, string> | null {
	if (typeof value === 'string') return { text: value };
	if (!isPlainObject(value)) return null;
	const document: Record<string, string> = {};
	if (typeof value.text === 'string') document.text = value.text;
	if (typeof value.image === 'string') document.image = value.image;
	return Object.keys(document).length > 0 ? document : null;
}

function canonicalRerankDocuments(value: unknown): Array<string | Record<string, string>> | null {
	if (!Array.isArray(value) || value.length === 0 || value.length > 2_048) return null;
	const documents: Array<string | Record<string, string>> = [];
	for (const item of value) {
		if (typeof item === 'string') {
			documents.push(item);
			continue;
		}
		const document = reconstructedDocument(item);
		if (!document) return null;
		documents.push(document);
	}
	return documents;
}

/** Revalidate after route defaults and strip every non-wire gateway control. */
function rerankRequestBodyForRoute(
	route: RouteResult,
	body: Record<string, unknown>,
	url: string,
): Record<string, unknown> {
	const routed = buildRouteRequestBody(route, body);
	const documents = canonicalRerankDocuments(routed.documents);
	if (typeof routed.query !== 'string' || !documents) {
		throw new Error('Rerank route defaults produced an invalid query or documents batch');
	}
	if (routed.top_n !== undefined && (
		typeof routed.top_n !== 'number'
		|| !Number.isSafeInteger(routed.top_n)
		|| routed.top_n < 1
	)) {
		throw new Error('Rerank route defaults produced an invalid top_n');
	}
	return {
		model: applyVertexOpenAiModelPrefix(url, route.providerModelName),
		query: routed.query,
		documents,
		...(routed.top_n === undefined ? {} : { top_n: routed.top_n }),
	};
}

function publicProviderName(route: RouteResult): string {
	const candidate = route.providerName.trim();
	return candidate && candidate.length <= 200 && !/[\u0000-\u001f\u007f-\u009f]/u.test(candidate)
		? candidate
		: route.providerId;
}

function invalidRerankSuccess(requestId?: string): {
	response: Response;
	usagePromise: Promise<UsageFromStream>;
	meta: ProxyDispatchMeta;
} {
	return {
		...invalidTextSuccessResponse({
			skin: 'chat',
			protocol: 'Rerank',
			requestId,
		}),
		usagePromise: Promise.resolve({ ...EMPTY_USAGE_LOCAL }),
	};
}

async function normalizeSuccessfulRerankResponse(
	response: Response,
	requestBody: Record<string, unknown>,
	route: RouteResult,
	publicCorrelationId?: string,
	timing?: RequestTimingCollector | null,
): Promise<{
	response: Response;
	usagePromise: Promise<UsageFromStream>;
	meta?: ProxyDispatchMeta;
}> {
	const contentType = response.headers.get('Content-Type') ?? '';
	if (!contentType.toLowerCase().includes('application/json')) {
		const invalid = await cancelInvalidTextSuccessResponse(response, {
			skin: 'chat', protocol: 'Rerank', requestId: publicCorrelationId,
		});
		timing?.markStreamComplete();
		return {
			...invalid,
			usagePromise: Promise.resolve({ ...EMPTY_USAGE_LOCAL }),
		};
	}

	const materialized = await readBoundedTextJsonObject(response, {
		skin: 'chat',
		requestId: publicCorrelationId,
		maxBytes: OPENAI_RERANK_RESPONSE_MAX_BYTES,
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
	const documents = requestBody.documents;
	const nativeId = object.id === undefined ? null : normalizeUpstreamId(object.id);
	if (
		!Array.isArray(documents)
		|| documents.length === 0
		|| typeof object.model !== 'string'
		|| !object.model.trim()
		|| !Array.isArray(object.results)
		|| object.results.length > documents.length
		|| (object.id !== undefined && nativeId == null)
	) return invalidRerankSuccess(publicCorrelationId);

	const indexes = new Set<number>();
	const results: Array<{
		index: number;
		relevance_score: number;
		document: Record<string, string>;
	}> = [];
	for (const item of object.results) {
		if (!isPlainObject(item)) return invalidRerankSuccess(publicCorrelationId);
		const index = item.index;
		const score = item.relevance_score;
		if (
			typeof index !== 'number'
			|| !Number.isSafeInteger(index)
			|| index < 0
			|| index >= documents.length
			|| indexes.has(index)
			|| typeof score !== 'number'
			|| !Number.isFinite(score)
		) return invalidRerankSuccess(publicCorrelationId);
		const document = reconstructedDocument(documents[index]);
		if (!document) return invalidRerankSuccess(publicCorrelationId);
		indexes.add(index);
		results.push({ index, relevance_score: score, document });
	}
	results.sort((left, right) => right.relevance_score - left.relevance_score || left.index - right.index);

	let usage: UsageFromStream = { ...EMPTY_USAGE_LOCAL };
	let publicUsage: Record<string, number> | undefined;
	if (object.usage !== undefined) {
		if (!isPlainObject(object.usage)) return invalidRerankSuccess(publicCorrelationId);
		const parsed = usageFromRerank(object.usage as RerankUsage);
		if (!parsed) return invalidRerankSuccess(publicCorrelationId);
		usage = parsed;
		publicUsage = normalizedRerankUsage(object.usage as RerankUsage) ?? undefined;
	}
	if (nativeId) usage = { ...usage, upstreamMessageId: nativeId };
	const normalized: Record<string, unknown> = {
		...(publicCorrelationId || nativeId ? { id: publicCorrelationId ?? nativeId } : {}),
		model: route.gatewayModelId ?? String(requestBody.model),
		provider: publicProviderName(route),
		results,
		...(publicUsage ? { usage: publicUsage } : {}),
	};
	return {
		response: rebuildTextJsonResponse(response, normalized),
		usagePromise: Promise.resolve(usage),
	};
}

/** Dispatch one OpenAI/OpenRouter-compatible rerank attempt. */
export async function dispatchOpenAiRerankRoute(
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
	const url = resolveUpstreamEndpoint('openai', 'rerank', route.providerEndpoints, {
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
	const requestBody = rerankRequestBodyForRoute(route, body, url);
	const { secret } = await resolveProviderUpstreamSecret(route.providerApiKey);
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
			method: 'POST', headers, body: serializedBody, signal: requestSignal,
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
	const normalized = await normalizeSuccessfulRerankResponse(
		response,
		requestBody,
		route,
		publicCorrelationId,
		timing,
	);
	return { ...normalized, upstreamRequestId };
}
