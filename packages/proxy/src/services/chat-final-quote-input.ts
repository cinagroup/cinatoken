import type { ModelFallbackPlanResult } from './model-fallback-plan';
import type { ParsedModelFallbacks } from './model-fallbacks';
import { MAX_REQUEST_BODY_BYTES } from './bounded-request-body';

type ResolvedPlan = Extract<ModelFallbackPlanResult, { ok: true }>;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const MAX_FINAL_BODY_BYTES = MAX_REQUEST_BODY_BYTES;

/** Public request bytes that can be quoted before any credential-bearing route read. */
export type FinalChatQuoteSnapshot = Readonly<{
	requestId: string;
	originalBodySha256: string;
	/** Exact UTF-8 text for a future DB issuer; model/models are normalized. */
	finalBodyUtf8: string;
	finalBodySha256: string;
	modelIds: readonly string[];
}>;

export type FinalChatQuoteInput = FinalChatQuoteSnapshot & Readonly<{
	/** Local mutation check; it does not independently authenticate a DB quote. */
	assertCurrent(body: Record<string, unknown>, parsed: ParsedModelFallbacks, plan: ResolvedPlan): void;
}>;

export class FinalChatQuoteInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'FinalChatQuoteInputError';
	}
}

function canonical(value: unknown): unknown {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new FinalChatQuoteInputError('Final Chat body contains a non-finite number');
		return Object.is(value, -0) ? 0 : value;
	}
	if (Array.isArray(value)) return value.map(canonical);
	if (typeof value === 'object') {
		if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
			throw new FinalChatQuoteInputError('Final Chat body contains a non-JSON object');
		}
		const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			const item = (value as Record<string, unknown>)[key];
			if (item === undefined) throw new FinalChatQuoteInputError('Final Chat body contains undefined');
			out[key] = canonical(item);
		}
		return out;
	}
	throw new FinalChatQuoteInputError('Final Chat body contains non-JSON data');
}

function canonicalJson(value: unknown): string {
	const encoded = JSON.stringify(canonical(value));
	if (typeof encoded !== 'string') throw new FinalChatQuoteInputError('Final Chat body is not JSON');
	return encoded;
}

function buildFinalBody(body: Record<string, unknown>, parsed: ParsedModelFallbacks): string {
	if (!Array.isArray(parsed.modelIds) || parsed.modelIds.length < 1 || parsed.modelIds.length > 8
		|| parsed.modelIds.some(id => typeof id !== 'string' || id.trim() !== id || id.length === 0)) {
		throw new FinalChatQuoteInputError('Final Chat model candidates are invalid');
	}
	if (new Set(parsed.modelIds).size !== parsed.modelIds.length) {
		throw new FinalChatQuoteInputError('Final Chat model candidates are duplicated');
	}
	// Build from the post-preset/post-Guardrail public body, then replace the
	// parser's control fields with its exact normalized candidate order.
	const normalized = {
		...body,
		model: parsed.modelIds[0],
		models: [...parsed.modelIds],
	};
	return canonicalJson(normalized);
}

function planBinding(plan: ResolvedPlan): string {
	return canonicalJson(plan.candidates.map(candidate => ({
		requestedModelId: candidate.requestedModelId,
		baseModelId: candidate.baseModelId,
		upstreamBody: candidate.upstreamBody,
		routeTargetIds: candidate.routes.map(route => route.targetId),
	})));
}

async function sha256Hex(data: BufferSource): Promise<string> {
	const bytes = await crypto.subtle.digest('SHA-256', data);
	return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
}

/** Semantic JSON digest independent of object insertion order. */
export function canonicalChatJsonSha256(value: unknown): Promise<string> {
	return sha256Hex(new TextEncoder().encode(canonicalJson(value)));
}

/** Hash the actual bounded ingress bytes before parsing/transformation. */
export async function originalChatBodySha256(raw: ArrayBuffer): Promise<string> {
	if (raw.byteLength > MAX_FINAL_BODY_BYTES) {
		throw new FinalChatQuoteInputError('Original Chat body exceeds quote input limit');
	}
	return sha256Hex(raw);
}

/**
 * Capture the final post-preset/post-Guardrail public body before route planning.
 * The database issuer independently selects and checks the complete manifest.
 * This is a local immutable input snapshot, never an authentication or quote receipt.
 */
export async function createFinalChatQuoteSnapshot(params: {
	requestId: string;
	originalBodySha256: string;
	finalBody: Record<string, unknown>;
	parsed: ParsedModelFallbacks;
}): Promise<FinalChatQuoteSnapshot & Readonly<{
	assertCurrent(body: Record<string, unknown>, parsed: ParsedModelFallbacks): void;
}>> {
	const requestId = params.requestId;
	const originalBodySha256 = params.originalBodySha256;
	if (typeof requestId !== 'string' || !requestId || requestId.length > 128
		|| typeof originalBodySha256 !== 'string' || !SHA256_RE.test(originalBodySha256)) {
		throw new FinalChatQuoteInputError('Final Chat quote identity is invalid');
	}
	const finalBodyUtf8 = buildFinalBody(params.finalBody, params.parsed);
	const bytes = new TextEncoder().encode(finalBodyUtf8);
	if (bytes.byteLength > MAX_FINAL_BODY_BYTES) {
		throw new FinalChatQuoteInputError('Final Chat body exceeds quote input limit');
	}
	// Snapshot every caller-owned value before the asynchronous digest.
	const modelIds = Object.freeze([...params.parsed.modelIds]);
	const finalBodySha256 = await sha256Hex(bytes);
	return Object.freeze({
		requestId, originalBodySha256, finalBodyUtf8, finalBodySha256, modelIds,
		assertCurrent(body: Record<string, unknown>, parsed: ParsedModelFallbacks) {
			if (buildFinalBody(body, parsed) !== finalBodyUtf8
				|| parsed.modelIds.length !== modelIds.length
				|| parsed.modelIds.some((id, index) => id !== modelIds[index])) {
				throw new FinalChatQuoteInputError('Final Chat quote input changed after capture');
			}
		},
	});
}

/**
 * Capture the final normalized body only after preset, Guardrail and model
 * planning have finished. The database must parse finalBodyUtf8 itself; this
 * Worker object is not an independently issued financial quote.
 */
export async function createFinalChatQuoteInput(params: {
	requestId: string;
	originalBodySha256: string;
	finalBody: Record<string, unknown>;
	parsed: ParsedModelFallbacks;
	plan: ResolvedPlan;
}): Promise<FinalChatQuoteInput> {
	if (params.plan.candidates.length !== params.parsed.modelIds.length
		|| params.plan.candidates.some((candidate, index) =>
			candidate.requestedModelId !== params.parsed.modelIds[index])) {
		throw new FinalChatQuoteInputError('Final Chat candidate plan differs from normalized body');
	}
	const capturedPlan = planBinding(params.plan);
	const captured = await createFinalChatQuoteSnapshot(params);
	const result: FinalChatQuoteInput = {
		...captured,
		assertCurrent(body, parsed, plan) {
			try { captured.assertCurrent(body, parsed); }
			catch (error) {
				if (!(error instanceof FinalChatQuoteInputError)) throw error;
				throw new FinalChatQuoteInputError('Final Chat quote input changed after planning');
			}
			if (planBinding(plan) !== capturedPlan) {
				throw new FinalChatQuoteInputError('Final Chat quote input changed after planning');
			}
		},
	};
	return Object.freeze(result);
}
