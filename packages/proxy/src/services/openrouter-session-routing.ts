import { createHash } from 'node:crypto';
import type { ResolvedModelSurfaceRow, UpstreamProtocol } from '@octafuse/core';
import type { RoutePoolStickyRoutingConfig } from '@octafuse/core/db/route-pool-sticky-types';
import type { RouteResult } from './model-router';
import type { ProviderPreferences } from './provider-routing-preferences';
import { stickyConfigFromSurface } from './provider-sticky-routing';
import { buildAffinityKey } from './route-strategies';

export const OPENROUTER_SESSION_ID_MAX_CHARS = 256;
export const OPENROUTER_SESSION_IDLE_TTL_SECONDS = 10 * 60;

export type OpenRouterStickySource = 'session_id' | 'prompt_cache_key' | 'messages';
export type OpenRouterStickySuccessPolicy = 'stream_success' | 'cache_hit';

export type OpenRouterSessionRouting = {
	/** Empty identifiers are accepted by the public schema but do not activate explicit sticky routing. */
	sessionId: string | null;
	source: 'body' | 'header' | null;
	/** Privacy-safe digest; raw cache keys and message content never enter affinity storage. */
	stickyKeyDigest: string | null;
	stickySource: OpenRouterStickySource | null;
	stickySuccessPolicy: OpenRouterStickySuccessPolicy | null;
};

export type PreparedOpenRouterSessionRouting =
	| {
		ok: true;
		body: Record<string, unknown>;
		routing: OpenRouterSessionRouting;
	}
	| { ok: false; message: string };

export type ParsedOpenRouterSessionHeader =
	| { ok: true; sessionId: string | null }
	| { ok: false; message: string };

export type OpenRouterRequestKind = 'chat' | 'responses' | 'messages';

type CanonicalHashTask =
	| { kind: 'value'; value: unknown }
	| { kind: 'string'; value: string }
	| { kind: 'leave'; value: object };

function unicodeCharacterLength(value: string): number {
	return Array.from(value).length;
}

function isWellFormedUnicode(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
			index += 1;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return false;
		}
	}
	return true;
}

function validateSessionId(value: unknown, source: 'body' | 'header'):
	| { ok: true; value: string | null }
	| { ok: false; message: string } {
	if (typeof value !== 'string') {
		return { ok: false, message: 'session_id must be a string' };
	}
	if (!isWellFormedUnicode(value)) {
		return { ok: false, message: 'session_id must contain valid Unicode' };
	}
	if (unicodeCharacterLength(value) > OPENROUTER_SESSION_ID_MAX_CHARS) {
		return {
			ok: false,
			message: `${source === 'header' ? 'x-session-id' : 'session_id'} must not exceed ${OPENROUTER_SESSION_ID_MAX_CHARS} characters`,
		};
	}
	return { ok: true, value: value === '' ? null : value };
}

/** Header-only session grouping for synchronous non-chat generation endpoints. */
export function parseOpenRouterSessionHeader(headers: Headers): ParsedOpenRouterSessionHeader {
	if (!headers.has('x-session-id')) return { ok: true, sessionId: null };
	const parsed = validateSessionId(headers.get('x-session-id') ?? '', 'header');
	return parsed.ok
		? { ok: true, sessionId: parsed.value }
		: parsed;
}

function updateUtf16String(
	hash: ReturnType<typeof createHash>,
	value: string,
): void {
	hash.update(`s${value.length}:`);
	const codeUnitsPerChunk = 4_096;
	const bytes = new Uint8Array(codeUnitsPerChunk * 2);
	for (let offset = 0; offset < value.length; offset += codeUnitsPerChunk) {
		const length = Math.min(codeUnitsPerChunk, value.length - offset);
		for (let index = 0; index < length; index += 1) {
			const code = value.charCodeAt(offset + index);
			bytes[index * 2] = code & 0xff;
			bytes[index * 2 + 1] = code >>> 8;
		}
		hash.update(bytes.subarray(0, length * 2));
	}
}

/** Hash JSON-like values without materializing another copy of a potentially large prompt. */
function canonicalDigest(domain: string, value: unknown): string | null {
	try {
		const hash = createHash('sha256');
		hash.update('cinatoken-openrouter-sticky-v2:');
		updateUtf16String(hash, domain);
		const active = new Set<object>();
		const stack: CanonicalHashTask[] = [{ kind: 'value', value }];
		while (stack.length > 0) {
			const task = stack.pop()!;
			if (task.kind === 'leave') {
				active.delete(task.value);
				hash.update(';');
				continue;
			}
			if (task.kind === 'string') {
				updateUtf16String(hash, task.value);
				continue;
			}

			const current = task.value;
			if (current === null) {
				hash.update('n;');
			} else if (typeof current === 'string') {
				updateUtf16String(hash, current);
			} else if (typeof current === 'boolean') {
				hash.update(current ? 'b1;' : 'b0;');
			} else if (typeof current === 'number' && Number.isFinite(current)) {
				hash.update(`d${Object.is(current, -0) ? '-0' : String(current)};`);
			} else if (typeof current === 'object') {
				if (active.has(current)) return null;
				active.add(current);
				stack.push({ kind: 'leave', value: current });
				if (Array.isArray(current)) {
					hash.update(`a${current.length}:`);
					for (let index = current.length - 1; index >= 0; index -= 1) {
						stack.push({ kind: 'value', value: current[index] });
					}
				} else {
					const record = current as Record<string, unknown>;
					const keys = Object.keys(record).sort();
					hash.update(`o${keys.length}:`);
					for (let index = keys.length - 1; index >= 0; index -= 1) {
						const key = keys[index]!;
						stack.push({ kind: 'value', value: record[key] });
						stack.push({ kind: 'string', value: key });
					}
				}
			} else {
				return null;
			}
		}
		return hash.digest('hex');
	} catch {
		return null;
	}
}

function roleOf(value: unknown): string | null {
	if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
	return typeof (value as Record<string, unknown>).role === 'string'
		? (value as Record<string, unknown>).role as string
		: null;
}

function firstMessagesForDigest(
	body: Record<string, unknown>,
	kind: OpenRouterRequestKind,
): [unknown | null, unknown | null] | null {
	let system: unknown | null = null;
	let nonSystem: unknown | null = null;

	if (kind === 'responses') {
		if (body.instructions != null) {
			system = { role: 'developer', content: body.instructions };
		}
		if (typeof body.input === 'string') {
			nonSystem = { role: 'user', content: body.input };
		} else if (Array.isArray(body.input)) {
			for (const item of body.input) {
				const role = roleOf(item);
				if (system == null && (role === 'system' || role === 'developer')) system = item;
				if (nonSystem == null && role != null && role !== 'system' && role !== 'developer') {
					nonSystem = item;
				}
				if (system != null && nonSystem != null) break;
			}
		}
	} else if (kind === 'messages') {
		if (body.system != null) system = { role: 'system', content: body.system };
		if (Array.isArray(body.messages)) {
			for (const message of body.messages) {
				const role = roleOf(message);
				if (role != null && role !== 'system' && role !== 'developer') {
					nonSystem = message;
					break;
				}
			}
		}
	} else if (Array.isArray(body.messages)) {
		for (const message of body.messages) {
			const role = roleOf(message);
			if (system == null && (role === 'system' || role === 'developer')) system = message;
			if (nonSystem == null && role != null && role !== 'system' && role !== 'developer') {
				nonSystem = message;
			}
			if (system != null && nonSystem != null) break;
		}
	}

	return nonSystem == null ? null : [system, nonSystem];
}

/**
 * Parse OpenRouter's request-level session control and remove it from the wire
 * body. A present body property always wins over the x-session-id header.
 */
export function prepareOpenRouterSessionRouting(
	body: Record<string, unknown>,
	headers: Headers,
): PreparedOpenRouterSessionRouting {
	const strippedBody = { ...body };
	if (Object.prototype.hasOwnProperty.call(body, 'session_id')) {
		const parsed = validateSessionId(body.session_id, 'body');
		if (!parsed.ok) return parsed;
		delete strippedBody.session_id;
		return {
			ok: true,
			body: strippedBody,
			routing: {
				sessionId: parsed.value,
				source: 'body',
				stickyKeyDigest: null,
				stickySource: null,
				stickySuccessPolicy: null,
			},
		};
	}

	if (headers.has('x-session-id')) {
		const parsed = validateSessionId(headers.get('x-session-id') ?? '', 'header');
		if (!parsed.ok) return parsed;
		return {
			ok: true,
			body: strippedBody,
			routing: {
				sessionId: parsed.value,
				source: 'header',
				stickyKeyDigest: null,
				stickySource: null,
				stickySuccessPolicy: null,
			},
		};
	}

	return {
		ok: true,
		body: strippedBody,
		routing: {
			sessionId: null,
			source: null,
			stickyKeyDigest: null,
			stickySource: null,
			stickySuccessPolicy: null,
		},
	};
}

/** Resolve explicit session, prompt_cache_key, then implicit opening-message affinity. */
export function resolveOpenRouterStickyRouting(
	routing: OpenRouterSessionRouting,
	body: Record<string, unknown>,
	kind: OpenRouterRequestKind,
): OpenRouterSessionRouting {
	if (routing.sessionId != null) {
		return {
			...routing,
			stickyKeyDigest: canonicalDigest('session_id', routing.sessionId),
			stickySource: 'session_id',
			stickySuccessPolicy: 'stream_success',
		};
	}

	if (typeof body.prompt_cache_key === 'string' && body.prompt_cache_key.length > 0) {
		return {
			...routing,
			stickyKeyDigest: canonicalDigest('prompt_cache_key', body.prompt_cache_key),
			stickySource: 'prompt_cache_key',
			stickySuccessPolicy: 'cache_hit',
		};
	}

	const opening = firstMessagesForDigest(body, kind);
	if (opening == null) return routing;
	const digest = canonicalDigest(`messages:${kind}`, opening);
	return digest == null
		? routing
		: {
				...routing,
				stickyKeyDigest: digest,
				stickySource: 'messages',
				stickySuccessPolicy: 'cache_hit',
			};
}

/** Tenant/model/conversation input for both deterministic routing and DB hashing. */
export function buildOpenRouterSessionAffinityKey(params: {
	userId: string;
	workspaceId: string;
	stickyKeyDigest: string;
	stickySource: OpenRouterStickySource;
	baseModelId: string;
}): string {
	return JSON.stringify([
		'openrouter-sticky-v2',
		params.userId,
		params.workspaceId,
		params.baseModelId,
		params.stickySource,
		params.stickyKeyDigest,
	]);
}

/** OpenRouter sticky sessions use a ten-minute idle window regardless of the pool default. */
export function openRouterSessionStickyConfig(
	surface: ResolvedModelSurfaceRow | null,
): RoutePoolStickyRoutingConfig {
	const pool = stickyConfigFromSurface(surface);
	return {
		...pool,
		enabled: true,
		idleTtlSeconds: OPENROUTER_SESSION_IDLE_TTL_SECONDS,
	};
}

export function routeHasBeneficialCacheReadPricing(route: RouteResult): boolean {
	const prompt = Number(route.endpoint?.pricing?.prompt);
	const cacheRead = Number(route.endpoint?.pricing?.input_cache_read);
	return Number.isFinite(prompt)
		&& Number.isFinite(cacheRead)
		&& prompt >= 0
		&& cacheRead >= 0
		&& cacheRead < prompt;
}

export function openRouterSessionDispatchOptions(params: {
	routing: OpenRouterSessionRouting;
	userId: string;
	workspaceId: string;
	baseModelId: string;
	routeGroup: string;
	protocol: UpstreamProtocol;
	surface: ResolvedModelSurfaceRow | null;
	hasProviderPreferences: boolean;
	routingPreferences: ProviderPreferences | null;
}): {
	affinityKey: string;
	sticky: RoutePoolStickyRoutingConfig | null;
	stickySuccessPolicy: OpenRouterStickySuccessPolicy | null;
	stickyRouteEligible: ((route: RouteResult) => boolean) | null;
} {
	const manualProviderOrder = (params.routingPreferences?.order.length ?? 0) > 0;
	if (
		params.routing.stickyKeyDigest != null
		&& params.routing.stickySource != null
		&& params.routing.stickySuccessPolicy != null
		&& !manualProviderOrder
	) {
		return {
			affinityKey: buildOpenRouterSessionAffinityKey({
				userId: params.userId,
				workspaceId: params.workspaceId,
				stickyKeyDigest: params.routing.stickyKeyDigest,
				stickySource: params.routing.stickySource,
				baseModelId: params.baseModelId,
			}),
			sticky: openRouterSessionStickyConfig(params.surface),
			stickySuccessPolicy: params.routing.stickySuccessPolicy,
			stickyRouteEligible: params.routing.stickySuccessPolicy === 'cache_hit'
				? routeHasBeneficialCacheReadPricing
				: null,
		};
	}

	return {
		affinityKey: buildAffinityKey(
			params.userId,
			params.baseModelId,
			params.routeGroup,
			params.protocol,
		),
		sticky: params.hasProviderPreferences
			? null
			: stickyConfigFromSurface(params.surface),
		stickySuccessPolicy: null,
		stickyRouteEligible: null,
	};
}
