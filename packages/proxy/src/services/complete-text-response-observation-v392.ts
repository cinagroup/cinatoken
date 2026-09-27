import { createHash } from 'node:crypto';

export const RESPONSE_OBSERVATION_LIMITS_V392 = Object.freeze({
	responseBytes: 16 * 1024 * 1024, jsonBytes: 1024 * 1024,
	eventBytes: 64 * 1024, events: 16_384, depth: 32, nodes: 16_384,
});
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const SHA = /^[0-9a-f]{64}$/u;
const NON_CANONICAL_NUMBER = Symbol('noncanonical JSON number');
export type CompleteTextResponseObservationV392 = Readonly<{
	format: 'json' | 'sse'; endMarker: 'json_eof' | 'sse_done_eof';
	rawResponseSha256: string; rawResponseBytes: number;
	providerRequestRef: string; reportedModel: string; httpRequestId: string | null;
	inputTokens: number; outputTokens: number; totalTokens: number;
	cacheReadTokens: number | null; cacheWriteTokens: number | null;
	reasoningTokens: number | null;
	audioInputTokens: number | null; imageInputTokens: number | null; textInputTokens: number | null;
	audioOutputTokens: number | null; textOutputTokens: number | null;
	acceptedPredictionTokens: number | null; rejectedPredictionTokens: number | null;
	serviceTier: string | null;
}>;
export type CompleteTextResponseObservationInputV392 = Readonly<{
	grantId: string; holderRunId: string; sendStartId: string; expectedEpoch: 1;
	evidenceNonce: string; observation: CompleteTextResponseObservationV392;
}>;
export type CommittedCompleteTextResponseObservationV392 = Readonly<{
	status: 'observation_recorded' | 'already_recorded';
	requestId: string; grantId: string; holderRunId: string; sendStartId: string;
	evidenceNonce: string; observationId: string; factId: string;
	observationSha256: string; commitAcknowledged: true; closeAcknowledged: true;
}>;
export type AppendResponseObservationV392 = (input: CompleteTextResponseObservationInputV392) =>
	Promise<CommittedCompleteTextResponseObservationV392>;

function invalid(): never { throw new TypeError('Complete text response observation invalid'); }
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
	return value as Record<string, unknown>;
}
function count(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 999_999_999) invalid();
	return value as number;
}
function ref(value: unknown): string {
	if (typeof value !== 'string' || !REF.test(value)) invalid();
	return value;
}

/** Bounded syntax parser. Duplicate decoded keys are rejected, including escaped aliases. */
function uniqueJson(text: string): unknown {
	let i = 0; let nodes = 0;
	const ws = () => { while (i < text.length && /[\t\r\n ]/u.test(text[i]!)) i++; };
	const string = (): string => {
		const start = i++;
		while (i < text.length) {
			const c = text[i++];
			if (c === '\\') i++;
			else if (c === '"') return JSON.parse(text.slice(start, i)) as string;
		}
		return invalid();
	};
	const value = (depth: number): unknown => {
		if (depth > RESPONSE_OBSERVATION_LIMITS_V392.depth || ++nodes > RESPONSE_OBSERVATION_LIMITS_V392.nodes) invalid();
		ws(); const c = text[i];
		if (c === '"') return string();
		if (c === '{' || c === '[') {
			i++; ws(); const end = c === '{' ? '}' : ']';
			const out: Record<string, unknown> | unknown[] = c === '{' ? Object.create(null) : [];
			if (text[i] === end) { i++; return out; }
			while (i < text.length) {
				ws();
				if (Array.isArray(out)) out.push(value(depth + 1));
				else {
					if (text[i] !== '"' || ++nodes > RESPONSE_OBSERVATION_LIMITS_V392.nodes) invalid();
					const key = string();
					if (Object.hasOwn(out, key)) invalid();
					ws(); if (text[i++] !== ':') invalid();
					out[key] = value(depth + 1);
				}
				ws(); if (text[i] === end) { i++; return out; }
				if (text[i++] !== ',') invalid();
			}
			return invalid();
		}
		const start = i;
		while (i < text.length && !/[\t\r\n ,}\]]/u.test(text[i]!)) i++;
		if (start === i) invalid();
		const token = text.slice(start, i);
		const parsed: unknown = JSON.parse(token);
		// Preserve a noncanonical number marker until a selected counter/index is
		// checked. Never let JSON.parse underflow/round a token into an integer
		// fact. Unselected metadata (e.g. logprobs) can still contain decimals.
		if (typeof parsed === 'number' && !/^(0|[1-9][0-9]*)$/u.test(token))
			return NON_CANONICAL_NUMBER;
		return parsed;
	};
	const out = value(0); ws(); if (i !== text.length) invalid(); return out;
}

export function responseObservationNonceV392(grantId: string, holderRunId: string, sendStartId: string): string {
	if (![grantId, holderRunId, sendStartId].every(x => UUID.test(x))) invalid();
	const bytes = createHash('sha256').update('cinatoken.complete_text.response.v392\0')
		.update(grantId).update('\0').update(holderRunId).update('\0').update(sendStartId).digest().subarray(0, 16);
	bytes[6] = (bytes[6]! & 15) | 80; bytes[8] = (bytes[8]! & 63) | 128;
	const s = Buffer.from(bytes).toString('hex'); return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** Exact flat jsonb text used by PostgreSQL, independently hashed by the caller. */
export function canonicalResponseObservationV392(observation: CompleteTextResponseObservationV392) {
	const fields = ['format', 'endMarker', 'rawResponseSha256', 'rawResponseBytes', 'providerRequestRef',
		'reportedModel', 'httpRequestId', 'inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens',
		'audioInputTokens', 'imageInputTokens', 'textInputTokens', 'audioOutputTokens', 'textOutputTokens',
		'acceptedPredictionTokens', 'rejectedPredictionTokens', 'serviceTier'];
	if (Object.keys(observation).sort().join(',') !== fields.sort().join(',')) invalid();
	if (!['json', 'sse'].includes(observation.format)
		|| observation.endMarker !== (observation.format === 'json' ? 'json_eof' : 'sse_done_eof')
		|| !SHA.test(observation.rawResponseSha256)
		|| !Number.isSafeInteger(observation.rawResponseBytes) || observation.rawResponseBytes < 1
		|| observation.rawResponseBytes > RESPONSE_OBSERVATION_LIMITS_V392.responseBytes
		|| (observation.format === 'json' && observation.rawResponseBytes > RESPONSE_OBSERVATION_LIMITS_V392.jsonBytes)) invalid();
	ref(observation.providerRequestRef); ref(observation.reportedModel);
	if (observation.httpRequestId !== null) ref(observation.httpRequestId);
	if (observation.serviceTier !== null) ref(observation.serviceTier);
	count(observation.inputTokens); count(observation.outputTokens); count(observation.totalTokens);
	if (observation.totalTokens !== observation.inputTokens + observation.outputTokens) invalid();
	for (const field of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'audioInputTokens', 'imageInputTokens',
		'textInputTokens', 'audioOutputTokens', 'textOutputTokens', 'acceptedPredictionTokens', 'rejectedPredictionTokens'] as const)
		if (observation[field] !== null) count(observation[field]);
	if ((observation.cacheReadTokens ?? 0) + (observation.cacheWriteTokens ?? 0) > observation.inputTokens
		|| (observation.reasoningTokens ?? 0) > observation.outputTokens) invalid();
	const keys = Object.keys(observation).sort((a, b) => Buffer.byteLength(a) - Buffer.byteLength(b)
		|| Buffer.compare(Buffer.from(a), Buffer.from(b)));
	const text = `{${keys.map(key => `${JSON.stringify(key)}: ${JSON.stringify(observation[key as keyof typeof observation])}`).join(', ')}}`;
	return Object.freeze({ text, digest: createHash('sha256').update(text).digest('hex') });
}

function usage(value: unknown) {
	const u = object(value);
	const allowed = new Set(['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_tokens_details', 'completion_tokens_details']);
	if (Object.keys(u).some(k => !allowed.has(k))) invalid();
	const inputTokens = count(u.prompt_tokens), outputTokens = count(u.completion_tokens), totalTokens = count(u.total_tokens);
	if (totalTokens !== inputTokens + outputTokens) invalid();
	const p = u.prompt_tokens_details == null ? {} : object(u.prompt_tokens_details);
	const c = u.completion_tokens_details == null ? {} : object(u.completion_tokens_details);
	// Unknown detail counters cannot silently disappear from a future pricing decision.
	if (Object.keys(p).some(k => !['cached_tokens', 'cache_creation_tokens', 'cache_write_tokens', 'audio_tokens', 'image_tokens', 'text_tokens'].includes(k))
		|| Object.keys(c).some(k => !['reasoning_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens', 'audio_tokens', 'text_tokens'].includes(k))) invalid();
	const optional = (v: unknown) => v === undefined ? null : count(v);
	if (p.cache_creation_tokens !== undefined && p.cache_write_tokens !== undefined && p.cache_creation_tokens !== p.cache_write_tokens) invalid();
	return { inputTokens, outputTokens, totalTokens,
		cacheReadTokens: optional(p.cached_tokens), cacheWriteTokens: optional(p.cache_write_tokens ?? p.cache_creation_tokens),
		reasoningTokens: optional(c.reasoning_tokens), audioInputTokens: optional(p.audio_tokens),
		imageInputTokens: optional(p.image_tokens), textInputTokens: optional(p.text_tokens),
		audioOutputTokens: optional(c.audio_tokens), textOutputTokens: optional(c.text_tokens),
		acceptedPredictionTokens: optional(c.accepted_prediction_tokens), rejectedPredictionTokens: optional(c.rejected_prediction_tokens) };
}

/**
 * Owns one source reader, never tees/re-fetches, and forwards exactly its bytes.
 * Hash means fetch-readable bytes (after HTTP decoding), not TLS/wire attestation.
 * A complete upstream observation is distinct from complete downstream delivery.
 */
export function observeCompleteTextResponseV392(response: Response,
	identity: Readonly<{ grantId: string; holderRunId: string; sendStartId: string; expectedEpoch: 1 }>,
	append: AppendResponseObservationV392,
) {
	const evidenceNonce = responseObservationNonceV392(identity.grantId, identity.holderRunId, identity.sendStartId);
	const media = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
	if (response.status !== 200 || !response.body || !['application/json', 'text/event-stream'].includes(media ?? '')
		|| identity.expectedEpoch !== 1 || typeof append !== 'function') invalid();
	const format = media === 'application/json' ? 'json' : 'sse';
	const headerRef = response.headers.get('x-request-id');
	const httpRequestId = headerRef === null ? null : ref(headerRef);
	const reader = response.body.getReader();
	const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
	const hash = createHash('sha256');
	let bytes = 0, text = '', eventCount = 0, eventLines: string[] = [], eventBytes = 0;
	let done = false, finished = false, terminal = false, released = false;
	let wirePending: number[] = [], lineBytes: number[] = [], pendingCR = false, eventClosed = false;
	const heldTail = new Uint8Array(format === 'json' ? RESPONSE_OBSERVATION_LIMITS_V392.jsonBytes : RESPONSE_OBSERVATION_LIMITS_V392.eventBytes);
	let heldTailBytes = 0;
	let responseId: string | undefined, model: string | undefined;
	let serviceTier: string | null | undefined;
	let counters: ReturnType<typeof usage> | undefined;
	let resolve!: (value: CommittedCompleteTextResponseObservationV392) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<CommittedCompleteTextResponseObservationV392>((yes, no) => { resolve = yes; reject = no; });
	const completion = { promise, resolve, reject };
	void completion.promise.catch(() => {});
	const release = () => { if (!released) { released = true; reader.releaseLock(); } };
	const event = () => {
		if (eventLines.length === 0) { eventBytes = 0; return; }
		if (++eventCount > RESPONSE_OBSERVATION_LIMITS_V392.events || done) invalid();
		const data = eventLines.join('\n'); eventLines = []; eventBytes = 0;
		if (data === '[DONE]') { if (!counters || !finished) invalid(); done = true; return; }
		const row = object(uniqueJson(data));
		if (row.error !== undefined || row.object !== 'chat.completion.chunk') invalid();
		const id = ref(row.id), nextModel = ref(row.model);
		const nextTier = row.service_tier == null ? null : ref(row.service_tier);
		if ((responseId !== undefined && responseId !== id) || (model !== undefined && model !== nextModel)) invalid();
		if (serviceTier != null && nextTier != null && serviceTier !== nextTier) invalid();
		responseId = id; model = nextModel; if (nextTier !== null) serviceTier = nextTier;
		if (!Array.isArray(row.choices) || counters) invalid();
		if (row.choices.length === 0) {
			if (!finished) invalid(); counters = usage(row.usage); return;
		}
		if (row.choices.length !== 1 || finished || row.usage != null) invalid();
		const choice = object(row.choices[0]); if (choice.index !== 0) invalid();
		object(choice.delta);
		if (choice.finish_reason != null) {
			if (!['stop', 'length', 'content_filter'].includes(choice.finish_reason as string)) invalid();
			finished = true;
		}
	};
	const line = (value: string) => {
		eventBytes += Buffer.byteLength(value) + 1;
		if (eventBytes > RESPONSE_OBSERVATION_LIMITS_V392.eventBytes) invalid();
		if (value === '') { event(); return; }
		if (value.startsWith(':')) return;
		// Event/id/retry fields are not used by the accepted OpenAI data-only stream.
		if (!value.startsWith('data:')) invalid();
		eventLines.push(value.slice(value[5] === ' ' ? 6 : 5));
	};
	const consumeSse = (part: Uint8Array, eof = false): Uint8Array[] => {
		const emitted: Uint8Array[] = [];
		const flush = () => {
			if (!eventClosed) return;
			const raw = Uint8Array.from(wirePending); wirePending = []; eventClosed = false;
			if (done) {
				if (heldTailBytes + raw.byteLength > heldTail.byteLength) invalid();
				heldTail.set(raw, heldTailBytes); heldTailBytes += raw.byteLength;
			} else emitted.push(raw);
		};
		const endLine = () => {
			const value = decoder.decode(Uint8Array.from(lineBytes)); lineBytes = [];
			line(value); eventClosed = value === '';
		};
		for (const byte of part) {
			if (pendingCR) {
				pendingCR = false;
				if (byte === 10) { wirePending.push(byte); flush(); continue; }
				flush();
			}
			wirePending.push(byte);
			if (wirePending.length > RESPONSE_OBSERVATION_LIMITS_V392.eventBytes) invalid();
			if (byte === 13) { endLine(); pendingCR = true; }
			else if (byte === 10) { endLine(); flush(); }
			else lineBytes.push(byte);
		}
		if (eof) { if (pendingCR) { pendingCR = false; flush(); } if (wirePending.length || lineBytes.length) invalid(); }
		return emitted;
	};
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (terminal) return;
			try {
				while (!terminal) {
				const part = await reader.read(); if (terminal) return;
				if (!part.done) {
					bytes += part.value.byteLength;
					if (bytes > (format === 'json' ? RESPONSE_OBSERVATION_LIMITS_V392.jsonBytes : RESPONSE_OBSERVATION_LIMITS_V392.responseBytes)) invalid();
					hash.update(part.value);
					if (format === 'json') { decoder.decode(part.value, { stream: true }); heldTail.set(part.value, heldTailBytes); heldTailBytes += part.value.byteLength; continue; }
					const emitted = consumeSse(part.value);
					for (const raw of emitted) controller.enqueue(raw);
					if (emitted.length) return;
					continue;
				}
				release();
				if (format === 'json') {
					decoder.decode();
					text = decoder.decode(heldTail.subarray(0, heldTailBytes));
					const row = object(uniqueJson(text));
					if (row.error !== undefined || row.object !== 'chat.completion' || !Array.isArray(row.choices) || row.choices.length !== 1) invalid();
					const choice = object(row.choices[0]), message = object(choice.message);
					if (choice.index !== 0 || !['stop', 'length', 'content_filter'].includes(choice.finish_reason as string)
						|| message.role !== 'assistant' || !(typeof message.content === 'string' || message.content === null)) invalid();
					responseId = ref(row.id); model = ref(row.model); counters = usage(row.usage);
					serviceTier = row.service_tier == null ? null : ref(row.service_tier);
				} else {
					for (const raw of consumeSse(new Uint8Array(), true)) controller.enqueue(raw);
					if (!done || eventLines.length !== 0) invalid();
				}
				if (!responseId || !model || !counters) invalid();
				const observation = Object.freeze({ format, endMarker: format === 'json' ? 'json_eof' : 'sse_done_eof',
					rawResponseSha256: hash.digest('hex'), rawResponseBytes: bytes,
					providerRequestRef: responseId, reportedModel: model, httpRequestId, serviceTier: serviceTier ?? null, ...counters } as const);
				const canonical = canonicalResponseObservationV392(observation);
				const receipt = await append(Object.freeze({ ...identity, evidenceNonce, observation }));
				if (!receipt || !['observation_recorded', 'already_recorded'].includes(receipt.status)
					|| !receipt.commitAcknowledged || !receipt.closeAcknowledged || receipt.grantId !== identity.grantId
					|| receipt.holderRunId !== identity.holderRunId || receipt.sendStartId !== identity.sendStartId
					|| receipt.evidenceNonce !== evidenceNonce || receipt.observationSha256 !== canonical.digest
					|| !UUID.test(receipt.observationId) || !UUID.test(receipt.factId)) invalid();
				completion.resolve(receipt);
				if (!terminal) { terminal = true; controller.enqueue(heldTail.subarray(0, heldTailBytes)); controller.close(); }
				return;
				}
			} catch (error) {
				if (!released) { try { await reader.cancel(error); } catch { /* Source already failed. */ } finally { release(); } }
				completion.reject(error);
				if (!terminal) { terminal = true; controller.error(error); }
			}
		},
		async cancel(reason) {
			if (terminal) return; terminal = true;
			completion.reject(new Error('Complete text response observation cancelled'));
			try { if (!released) await reader.cancel(reason); } finally { release(); }
		},
	}, { highWaterMark: 0 });
	return Object.freeze({ response: new Response(body, { status: response.status,
		statusText: response.statusText, headers: response.headers }), completion: completion.promise });
}
