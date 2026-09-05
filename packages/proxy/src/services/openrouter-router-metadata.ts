import type { ModelFallbackCandidatePlan } from './model-fallback-plan';
import type { RouteResult } from './model-router';
import type { RequestTimingCollector, RouterMetadataTimingAttempt } from './request-timing';
import {
	responseTextWithinLimit,
	UpstreamResponseBodyTooLargeError,
} from './egress/bounded-response-body';
import {
	rebuildTextJsonResponse,
	TEXT_JSON_RESPONSE_MAX_BYTES,
} from './egress/text-json-response';
import {
	buildAnthropicMidstreamErrorEvent,
	buildChatMidstreamErrorEvent,
	buildCompletionsMidstreamErrorEvent,
	buildResponsesFailedEvent,
} from './openrouter-error-protocol';
import { isPrivateByokRoute } from './byok-key-pool';

export const OPENROUTER_METADATA_HEADER = 'X-OpenRouter-Metadata';
export const OPENROUTER_METADATA_LEGACY_HEADER = 'X-OpenRouter-Experimental-Metadata';

const MAX_PUBLIC_TEXT_CHARS = 256;
const MAX_ENDPOINTS = 64;
const MAX_ATTEMPTS = 32;
/** Upstream text drivers accept 256 KiB events; leave bounded room for metadata. */
export const MAX_ROUTER_METADATA_SSE_EVENT_CHARS = 384 * 1024;
/**
 * Bound all complete events retained while locating the terminal JSON event.
 * Two MiB accommodates one maximum multi-byte event plus the bounded public
 * metadata projection while remaining small relative to a Worker isolate.
 */
export const MAX_ROUTER_METADATA_SSE_QUEUED_BYTES = 2 * 1024 * 1024;
export const MAX_ROUTER_METADATA_SSE_QUEUED_EVENTS = 256;

const ROUTER_METADATA_STREAM_LIMIT_MESSAGE =
	'Gateway response stream exceeded the safe buffering limit';

class RouterMetadataSseQueueLimitError extends Error {
	constructor() {
		super(ROUTER_METADATA_STREAM_LIMIT_MESSAGE);
		this.name = 'RouterMetadataSseQueueLimitError';
	}
}

export type RouterMetadataProtocol = 'chat' | 'completions' | 'responses' | 'messages';

export type RouterMetadataGuardrailStage = {
	type: 'guardrail';
	name: 'content-filter';
	summary: string;
	data: {
		action: 'blocked' | 'redacted' | 'flagged';
		phase: 'request' | 'response';
		flagged: true;
		detected: true;
		match_count?: number;
	};
};

/**
 * Pipeline data is intentionally additive. Known CinaToken stages use a strict
 * safe projection; future plugin types remain representable without forcing
 * clients to reject an otherwise valid Router Metadata response.
 */
export type RouterMetadataPipelineStage = RouterMetadataGuardrailStage | {
	type: 'plugin' | 'server_tools' | 'response_healing' | 'context_compression';
	name: string;
	summary?: string;
	data: Record<string, unknown>;
};

type RouterMetadataPerformancePreference =
	| number
	| Partial<Record<'p50' | 'p75' | 'p90' | 'p99', number>>;

/**
 * Public, request-derived routing controls that materially affected endpoint
 * selection. This is deliberately narrower than the internal routing trace:
 * configured/eligible target ids and every credential-scoped field stay
 * private even when Router Metadata is enabled.
 */
export type RouterMetadataParams = {
	/** OpenRouter RouterParams scalar; our numeric preference means p50. */
	throughput_floor?: number;
	/** CinaToken extension retained when percentile-specific floors were applied. */
	preferred_min_throughput?: RouterMetadataPerformancePreference;
	/** CinaToken extension for the symmetric latency ceiling. */
	preferred_max_latency?: RouterMetadataPerformancePreference;
	sort?: string | { by: string; partition: 'none' };
	require_parameters?: true;
	data_collection?: 'deny';
	zdr?: true;
	quantizations?: string[];
	max_price?: Record<string, number>;
	service_tier?: 'default' | 'flex' | 'priority';
	speed?: 'fast' | 'standard';
	model_variant?: 'nitro' | 'floor';
};

export type OpenRouterMetadata = {
	requested: string;
	strategy: 'direct' | 'free' | 'latest' | 'alias' | 'fallback';
	region: string | null;
	summary: string;
	attempt: number;
	is_byok: boolean;
	endpoints: {
		total: number;
		available: Array<{
			provider: string;
			model: string;
			selected: boolean;
		}>;
	};
	params?: RouterMetadataParams;
	attempts?: Array<{
		provider: string;
		model: string;
		status: number;
	}>;
	pipeline?: RouterMetadataPipelineStage[];
};

export type AttachOpenRouterMetadataOptions = {
	enabled: boolean;
	protocol: RouterMetadataProtocol;
	requestHeaders: Headers;
	requestedModelIds: readonly string[];
	candidates: readonly ModelFallbackCandidatePlan[];
	timing: RequestTimingCollector;
	chosenRoute?: RouteResult | null;
	pipeline?: readonly RouterMetadataPipelineStage[];
};

function publicText(value: string | null | undefined, fallback: string): string {
	const normalized = (value ?? '')
		.replace(/[\u0000-\u001f\u007f]+/gu, ' ')
		.trim()
		.slice(0, MAX_PUBLIC_TEXT_CHARS);
	return normalized || fallback;
}

/** The current header wins when both current and legacy names are present. */
export function openRouterMetadataRequested(headers: Headers): boolean {
	const current = headers.get(OPENROUTER_METADATA_HEADER);
	const raw = current !== null
		? current
		: headers.get(OPENROUTER_METADATA_LEGACY_HEADER);
	return raw?.trim().toLowerCase() === 'enabled';
}

export function openRouterMetadataRegion(headers: Headers): string | null {
	const ray = headers.get('CF-Ray')?.trim() ?? '';
	const match = /-([a-z0-9]{3})$/iu.exec(ray);
	return match?.[1]?.toLowerCase() ?? null;
}

export function routerMetadataGuardrailStage(
	phase: 'request' | 'response',
	action: 'blocked' | 'redacted' | 'flagged',
	matchCount?: number,
): RouterMetadataGuardrailStage {
	const normalizedCount = typeof matchCount === 'number'
		&& Number.isSafeInteger(matchCount)
		&& matchCount > 0
		? Math.min(matchCount, 1_000_000)
		: null;
	const verb = action === 'blocked' ? 'blocked' : action === 'redacted' ? 'redacted' : 'flagged';
	return {
		type: 'guardrail',
		name: 'content-filter',
		summary: `${phase === 'request' ? 'Request' : 'Response'} content ${verb}${normalizedCount == null ? '' : ` (${normalizedCount} match${normalizedCount === 1 ? '' : 'es'})`}`,
		data: {
			action,
			phase,
			flagged: true,
			detected: true,
			...(normalizedCount == null ? {} : { match_count: normalizedCount }),
		},
	};
}

function clonePerformancePreference(
	value: RouterMetadataPerformancePreference | null | undefined,
): RouterMetadataPerformancePreference | null {
	if (typeof value === 'number') {
		return Number.isFinite(value) && value >= 0 ? value : null;
	}
	if (!value) return null;
	const result: Partial<Record<'p50' | 'p75' | 'p90' | 'p99', number>> = {};
	for (const percentile of ['p50', 'p75', 'p90', 'p99'] as const) {
		const threshold = value[percentile];
		if (typeof threshold === 'number' && Number.isFinite(threshold) && threshold >= 0) {
			result[percentile] = threshold;
		}
	}
	return Object.keys(result).length > 0 ? result : null;
}

function strategyFor(
	requestedModelIds: readonly string[],
	candidates: readonly ModelFallbackCandidatePlan[],
): OpenRouterMetadata['strategy'] {
	if (requestedModelIds.length > 1) return 'fallback';
	const requested = requestedModelIds[0]?.trim() ?? '';
	const lower = requested.toLowerCase();
	if (lower.endsWith(':free')) return 'free';
	if (lower.endsWith(':latest')) return 'latest';
	const baseModelId = candidates[0]?.baseModelId;
	if (baseModelId && requested && requested !== baseModelId) return 'alias';
	return 'direct';
}

function publicAttemptModel(
	attempt: RouterMetadataTimingAttempt,
	requestedModelIds: readonly string[],
): string {
	const candidate = attempt.candidateIndex == null
		? undefined
		: requestedModelIds[attempt.candidateIndex];
	return publicText(candidate ?? requestedModelIds[0], 'unknown');
}

function publicRouterParams(
	candidates: readonly ModelFallbackCandidatePlan[],
	chosenRoute: RouteResult | null | undefined,
): RouterMetadataParams | null {
	let trace = chosenRoute?.providerRoutingTrace;
	if (!trace) {
		outer: for (const candidate of candidates) {
			for (const route of candidate.routes) {
				if (!route.providerRoutingTrace) continue;
				trace = route.providerRoutingTrace;
				break outer;
			}
		}
	}
	if (!trace) return null;

	const params: RouterMetadataParams = {};
	if (trace.sort) {
		params.sort = trace.partition === 'none'
			? { by: trace.sort, partition: 'none' }
			: trace.sort;
	}
	if (trace.require_parameters) params.require_parameters = true;
	if (trace.data_collection === 'deny') params.data_collection = 'deny';
	if (trace.zdr) params.zdr = true;
	if (trace.quantizations && trace.quantizations.length > 0) {
		params.quantizations = [...trace.quantizations];
	}
	if (trace.max_price && Object.keys(trace.max_price).length > 0) {
		params.max_price = { ...trace.max_price };
	}
	const minimumThroughput = clonePerformancePreference(trace.preferred_min_throughput);
	if (typeof minimumThroughput === 'number') {
		params.throughput_floor = minimumThroughput;
	} else if (minimumThroughput) {
		if (minimumThroughput.p50 !== undefined) {
			params.throughput_floor = minimumThroughput.p50;
		}
		params.preferred_min_throughput = minimumThroughput;
	}
	const maximumLatency = clonePerformancePreference(trace.preferred_max_latency);
	if (maximumLatency != null) params.preferred_max_latency = maximumLatency;
	if (trace.service_tier) params.service_tier = trace.service_tier;
	if (trace.speed) params.speed = trace.speed;
	if (trace.model_variant) params.model_variant = trace.model_variant;

	return Object.keys(params).length > 0 ? params : null;
}

export function buildOpenRouterMetadata(
	response: Pick<Response, 'ok'>,
	options: Omit<AttachOpenRouterMetadataOptions, 'enabled' | 'protocol'>,
): OpenRouterMetadata {
	const requested = publicText(options.requestedModelIds[0], 'unknown');
	const selectedTargetId = response.ok ? options.chosenRoute?.targetId ?? null : null;
	const available: OpenRouterMetadata['endpoints']['available'] = [];
	let total = 0;
	let selectedEndpoint: OpenRouterMetadata['endpoints']['available'][number] | null = null;
	let selectedEndpointListed = false;

	for (let candidateIndex = 0; candidateIndex < options.candidates.length; candidateIndex += 1) {
		const candidate = options.candidates[candidateIndex]!;
		const model = publicText(candidate.requestedModelId, requested);
		for (const route of candidate.routes) {
			total += 1;
			const endpoint = {
				provider: publicText(route.providerName, 'Unknown'),
				model,
				selected: selectedTargetId !== null && route.targetId === selectedTargetId,
			};
			if (endpoint.selected) selectedEndpoint = endpoint;
			if (available.length < MAX_ENDPOINTS) {
				available.push(endpoint);
				if (endpoint.selected) selectedEndpointListed = true;
			}
		}
	}
	if (selectedEndpoint && !selectedEndpointListed && available.length > 0) {
		available[available.length - 1] = selectedEndpoint;
	}

	const timingAttempts = options.timing.routerMetadataAttempts();
	const successfulAttempt = response.ok
		? timingAttempts.find((attempt) =>
			attempt.selected
			&& attempt.status != null
			&& attempt.status >= 200
			&& attempt.status < 300)
		: undefined;
	const attempt = successfulAttempt?.index ?? timingAttempts.length;
	const attempts = timingAttempts
		.filter((item): item is RouterMetadataTimingAttempt & { status: number } => item.status != null)
		.slice(0, MAX_ATTEMPTS)
		.map((item) => ({
			provider: publicText(item.providerName, 'Unknown'),
			model: publicAttemptModel(item, options.requestedModelIds),
			status: item.status,
		}));
	const selectedProvider = response.ok
		? publicText(options.chosenRoute?.providerName, '')
		: '';
	const pipeline = options.pipeline?.slice(0, 16);
	const params = publicRouterParams(options.candidates, options.chosenRoute);

	return {
		requested,
		strategy: strategyFor(options.requestedModelIds, options.candidates),
		region: openRouterMetadataRegion(options.requestHeaders),
		summary: `available=${total}${selectedProvider ? `, selected=${selectedProvider}` : ''}`,
		attempt,
		is_byok: response.ok && options.chosenRoute != null
			? isPrivateByokRoute(options.chosenRoute)
			: false,
		endpoints: { total, available },
		...(params ? { params } : {}),
		...(attempts.length > 0 ? { attempts } : {}),
		...(pipeline && pipeline.length > 0 ? { pipeline: [...pipeline] } : {}),
	};
}

type ParsedSseEvent = {
	raw: string;
	data: string | null;
	json: Record<string, unknown> | null;
};

type RetainedSseEvent = {
	event: ParsedSseEvent;
	wireByteLength: number;
};

function parseSseEvent(raw: string): ParsedSseEvent {
	const lines = raw.split(/\r\n|\n|\r/u);
	const data: string[] = [];
	for (const line of lines) {
		if (!line.startsWith('data:')) continue;
		const value = line.slice('data:'.length);
		data.push(value.startsWith(' ') ? value.slice(1) : value);
	}
	if (data.length === 0) return { raw, data: null, json: null };
	const joined = data.join('\n');
	if (joined.trim() === '[DONE]') return { raw, data: '[DONE]', json: null };
	try {
		const parsed = JSON.parse(joined) as unknown;
		return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)
			? { raw, data: joined, json: parsed as Record<string, unknown> }
			: { raw, data: joined, json: null };
	} catch {
		return { raw, data: joined, json: null };
	}
}

function replaceSseEventJson(
	event: ParsedSseEvent,
	metadata: OpenRouterMetadata,
): string {
	if (!event.json) return event.raw;
	const replacement = `data: ${JSON.stringify({
		...event.json,
		openrouter_metadata: metadata,
	})}`;
	const lines = event.raw.split(/\r\n|\n|\r/u);
	const output: string[] = [];
	let replaced = false;
	for (const line of lines) {
		if (line.startsWith('data:')) {
			if (!replaced) output.push(replacement);
			replaced = true;
			continue;
		}
		output.push(line);
	}
	return output.join('\n');
}

function nextEventBoundary(buffer: string): { index: number; length: number } | null {
	const match = /\r\n\r\n|\n\n|\r\r/u.exec(buffer);
	return match?.index == null ? null : { index: match.index, length: match[0].length };
}

function routerMetadataStreamLimitFailure(
	protocol: RouterMetadataProtocol,
	metadata: OpenRouterMetadata,
	associationId: string | null,
): string {
	if (protocol === 'messages') {
		return buildAnthropicMidstreamErrorEvent({
			message: ROUTER_METADATA_STREAM_LIMIT_MESSAGE,
			requestId: associationId,
		});
	}
	if (protocol === 'responses') {
		return buildResponsesFailedEvent({
			id: associationId,
			model: metadata.requested,
			message: ROUTER_METADATA_STREAM_LIMIT_MESSAGE,
		});
	}
	if (protocol === 'completions') {
		return buildCompletionsMidstreamErrorEvent({
			id: associationId,
			model: metadata.requested,
			provider: '',
			message: ROUTER_METADATA_STREAM_LIMIT_MESSAGE,
		});
	}
	return buildChatMidstreamErrorEvent({
		id: associationId,
		model: metadata.requested,
		provider: '',
		message: ROUTER_METADATA_STREAM_LIMIT_MESSAGE,
	});
}

function streamAssociationIdFromEvent(
	protocol: RouterMetadataProtocol,
	json: Record<string, unknown> | null,
): string | null {
	if (!json) return null;
	if (protocol === 'chat' || protocol === 'completions') {
		return typeof json.id === 'string' && json.id.length > 0 ? json.id : null;
	}
	if (protocol === 'responses') {
		const response = json.response;
		if (response && typeof response === 'object' && !Array.isArray(response)) {
			const id = (response as Record<string, unknown>).id;
			if (typeof id === 'string' && id.length > 0) return id;
		}
		return typeof json.id === 'string' && json.id.length > 0 ? json.id : null;
	}
	const message = json.message;
	if (message && typeof message === 'object' && !Array.isArray(message)) {
		const id = (message as Record<string, unknown>).id;
		if (typeof id === 'string' && id.length > 0) return id;
	}
	return typeof json.request_id === 'string' && json.request_id.length > 0
		? json.request_id
		: null;
}

function streamWithRouterMetadata(
	body: ReadableStream<Uint8Array>,
	protocol: RouterMetadataProtocol,
	metadata: OpenRouterMetadata,
): ReadableStream<Uint8Array> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	const output: Uint8Array[] = [];
	let buffer = '';
	let sourceDone = false;
	let readerReleased = false;
	let readerCancelPromise: Promise<void> | null = null;
	let pendingJson: RetainedSseEvent | null = null;
	let pendingAfter: RetainedSseEvent[] = [];
	let pendingBytes = 0;
	let pendingEvents = 0;
	let streamAssociationId: string | null = null;

	const assertRetentionBudget = (nextBytes: number, nextEvents: number): void => {
		if (
			pendingBytes + nextBytes > MAX_ROUTER_METADATA_SSE_QUEUED_BYTES
			|| pendingEvents + nextEvents > MAX_ROUTER_METADATA_SSE_QUEUED_EVENTS
		) {
			throw new RouterMetadataSseQueueLimitError();
		}
	};
	const encodeEvent = (raw: string): Uint8Array => encoder.encode(`${raw}\n\n`);
	const enqueueBytes = (bytes: Uint8Array): void => {
		output.push(bytes);
	};
	const enqueueEvent = (raw: string): void => {
		enqueueBytes(encodeEvent(raw));
	};
	const retainEvent = (event: ParsedSseEvent): RetainedSseEvent => {
		const retained = { event, wireByteLength: encodeEvent(event.raw).byteLength };
		assertRetentionBudget(retained.wireByteLength, 1);
		pendingBytes += retained.wireByteLength;
		pendingEvents += 1;
		return retained;
	};
	const releaseRetained = (retained: RetainedSseEvent): void => {
		pendingBytes -= retained.wireByteLength;
		pendingEvents -= 1;
	};
	const flushPending = (inject: boolean): void => {
		if (!pendingJson) return;
		const json = pendingJson;
		pendingJson = null;
		releaseRetained(json);
		enqueueEvent(inject ? replaceSseEventJson(json.event, metadata) : json.event.raw);
		const after = pendingAfter;
		pendingAfter = [];
		for (const retained of after) {
			releaseRetained(retained);
			enqueueEvent(retained.event.raw);
		}
	};
	const processEvent = (raw: string): void => {
		const event = parseSseEvent(raw);
		streamAssociationId = streamAssociationIdFromEvent(protocol, event.json)
			?? streamAssociationId;
		if (protocol === 'messages') {
			const type = typeof event.json?.type === 'string' ? event.json.type : '';
			enqueueEvent(
				type === 'message_stop' || type === 'error'
					? replaceSseEventJson(event, metadata)
					: event.raw,
			);
			return;
		}
		if (event.data === '[DONE]') {
			flushPending(true);
			enqueueEvent(event.raw);
			return;
		}
		if (event.json) {
			flushPending(false);
			pendingJson = retainEvent(event);
			return;
		}
		if (pendingJson) pendingAfter.push(retainEvent(event));
		else enqueueEvent(event.raw);
	};
	const extractCompleteEvents = (): void => {
		while (output.length === 0) {
			const boundary = nextEventBoundary(buffer);
			if (!boundary) break;
			const raw = buffer.slice(0, boundary.index);
			buffer = buffer.slice(boundary.index + boundary.length);
			if (raw.length > MAX_ROUTER_METADATA_SSE_EVENT_CHARS) {
				throw new Error('Router Metadata SSE event exceeded the gateway framing limit');
			}
			if (raw.length > 0) processEvent(raw);
		}
		const nextBoundary = nextEventBoundary(buffer);
		if (!nextBoundary && buffer.length > MAX_ROUTER_METADATA_SSE_EVENT_CHARS) {
			throw new Error('Router Metadata SSE event exceeded the gateway framing limit');
		}
	};
	const finishSource = (): void => {
		buffer += decoder.decode();
		if (buffer.length > MAX_ROUTER_METADATA_SSE_EVENT_CHARS) {
			throw new Error('Router Metadata SSE event exceeded the gateway framing limit');
		}
		if (buffer.length > 0) processEvent(buffer);
		buffer = '';
		if (protocol !== 'messages') flushPending(true);
		sourceDone = true;
	};
	const releaseReader = (): void => {
		if (readerReleased) return;
		readerReleased = true;
		reader.releaseLock();
	};
	const cancelReader = async (reason: unknown): Promise<void> => {
		if (readerReleased) return;
		readerCancelPromise ??= (async () => {
			try {
				await reader.cancel(reason).catch(() => undefined);
			} finally {
				releaseReader();
			}
		})();
		await readerCancelPromise;
	};
	const clearQueues = (): void => {
		output.length = 0;
		buffer = '';
		pendingJson = null;
		pendingAfter = [];
		pendingBytes = 0;
		pendingEvents = 0;
	};

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				while (output.length === 0 && !sourceDone) {
					extractCompleteEvents();
					if (output.length > 0) break;
					const next = await reader.read();
					if (next.done) {
						finishSource();
						releaseReader();
						break;
					}
					buffer += decoder.decode(next.value, { stream: true });
					extractCompleteEvents();
				}
				while (output.length > 0 && (controller.desiredSize ?? 1) > 0) {
					const bytes = output.shift()!;
					controller.enqueue(bytes);
				}
				if (sourceDone && output.length === 0) controller.close();
			} catch (error) {
				sourceDone = true;
				if (error instanceof RouterMetadataSseQueueLimitError) {
					clearQueues();
					await cancelReader('router_metadata_stream_queue_limit');
					controller.enqueue(encoder.encode(routerMetadataStreamLimitFailure(
						protocol,
						metadata,
						streamAssociationId,
					)));
					controller.close();
					return;
				}
				await cancelReader('router_metadata_stream_failed');
				controller.error(error);
			}
		},
		async cancel(reason) {
			sourceDone = true;
			clearQueues();
			await cancelReader(reason);
		},
	});
}

async function attachJsonMetadata(
	response: Response,
	metadata: OpenRouterMetadata,
): Promise<Response> {
	let clone: Response;
	try {
		clone = response.clone();
	} catch {
		return response;
	}
	try {
		const text = await responseTextWithinLimit(clone, TEXT_JSON_RESPONSE_MAX_BYTES);
		const parsed = JSON.parse(text) as unknown;
		if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return response;
		await response.body?.cancel('router_metadata_response_rebuilt').catch(() => undefined);
		return rebuildTextJsonResponse(response, {
			...(parsed as Record<string, unknown>),
			openrouter_metadata: metadata,
		});
	} catch (error) {
		if (!(error instanceof UpstreamResponseBodyTooLargeError)) {
			await clone.body?.cancel('router_metadata_json_parse_failed').catch(() => undefined);
		}
		return response;
	}
}

/** Add the opt-in field without exposing any internal route or credential DTO. */
export async function attachOpenRouterMetadata(
	response: Response,
	options: AttachOpenRouterMetadataOptions,
): Promise<Response> {
	if (!options.enabled || response.status === 500 || response.body == null) return response;
	const metadata = buildOpenRouterMetadata(response, options);
	const contentType = response.headers.get('Content-Type')?.toLowerCase() ?? '';
	if (contentType.includes('text/event-stream')) {
		const headers = new Headers(response.headers);
		headers.delete('Content-Length');
		headers.delete('Content-Encoding');
		headers.delete('Transfer-Encoding');
		return new Response(streamWithRouterMetadata(response.body, options.protocol, metadata), {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}
	if (contentType.includes('application/json')) {
		return attachJsonMetadata(response, metadata);
	}
	return response;
}
