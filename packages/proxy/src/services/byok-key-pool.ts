/**
 * Request-scoped private BYOK credential expansion.
 *
 * A route target remains the routing/sticky identity. Credential clones only
 * change the upstream secret and provider-key audit identity. Request ordering
 * is global: every primary BYOK attempt, then allowed shared/platform attempts,
 * then every fallback BYOK attempt. Prioritized keys expose three shared-capacity
 * levels: allow it, suppress it when all key filters match, or suppress the same
 * provider even when the requested model is outside the key's model filter.
 * Member and Gateway-key filters always scope the policy. Each section preserves
 * route/key order.
 */
import {
	BYOK_MAX_RUNTIME_KEYS,
	type ByokRuntimeKeyRow,
	type GatewayRepositories,
} from '@octafuse/core';
import type { RouteResult } from './model-router';

export const BYOK_KEY_ID_PREFIX = 'byok:';

export type PrivateByokRequestContext = {
	workspaceId: string;
	userId: string;
	/** Lowercase SHA-256 hex of the authenticated Gateway API key, without a prefix. */
	apiKeyHash: string;
};

export function privateByokContextForApiKey(
	apiKey: PrivateByokRequestContext,
): PrivateByokRequestContext {
	return {
		workspaceId: apiKey.workspaceId,
		userId: apiKey.userId,
		apiKeyHash: apiKey.apiKeyHash,
	};
}

export function parseByokKeyId(
	providerKeyId: string | null | undefined,
): string | null {
	if (!providerKeyId?.startsWith(BYOK_KEY_ID_PREFIX)) return null;
	const id = providerKeyId.slice(BYOK_KEY_ID_PREFIX.length);
	return id.length > 0 ? id : null;
}

export function isPrivateByokRoute(
	route: Pick<RouteResult, 'providerKeyId'>,
): boolean {
	return parseByokKeyId(route.providerKeyId) !== null;
}

export function applyByokKeyToRoute(
	route: RouteResult,
	key: ByokRuntimeKeyRow,
): RouteResult {
	return {
		...route,
		providerApiKey: key.api_key,
		providerKeyId: `${BYOK_KEY_ID_PREFIX}${key.id}`,
		// The repository exposes only a non-reusable suffix label, never a key prefix.
		providerKeyLabel: key.label,
		providerKeyFingerprint: key.label,
		gatewayPrivateByokFallback: key.is_fallback,
	};
}

function routeModelId(route: RouteResult): string | null {
	const modelId = route.gatewayModelId ?? route.endpoint?.modelId ?? '';
	return modelId.trim() || null;
}

function routeProviderSlug(route: RouteResult): string | null {
	return route.endpoint?.providerSlug.trim() || null;
}

async function loadPrivateKeys(
	repos: GatewayRepositories,
	context: PrivateByokRequestContext,
	route: RouteResult,
): Promise<{ keys: ByokRuntimeKeyRow[]; lookupFailed: boolean }> {
	const provider = routeProviderSlug(route);
	const modelId = routeModelId(route);
	if (!provider || !modelId) return { keys: [], lookupFailed: false };
	try {
		const keys = await repos.byokKeys.listActiveForRequest({
			workspaceId: context.workspaceId,
			provider,
			modelId,
			userId: context.userId,
			apiKeyHash: context.apiKeyHash,
		});
		return { keys: keys.slice(0, BYOK_MAX_RUNTIME_KEYS), lookupFailed: false };
	} catch (error) {
		// BYOK lookup/decryption must not expose secret material. This route fails
		// closed with respect to same-provider shared/platform capacity because the
		// unreadable policy may explicitly prohibit that spend.
		console.warn(JSON.stringify({
			message: 'private BYOK lookup failed',
			provider,
			model_id: modelId,
			error_kind: error instanceof Error ? error.name : 'unknown',
		}));
		return { keys: [], lookupFailed: true };
	}
}

async function loadSharedCapacityPolicy(
	repos: GatewayRepositories,
	context: PrivateByokRequestContext,
	route: RouteResult,
): Promise<{ suppress: boolean; lookupFailed: boolean }> {
	const provider = routeProviderSlug(route);
	const modelId = routeModelId(route);
	if (!provider || !modelId) return { suppress: false, lookupFailed: false };
	// Older isolated test doubles may only implement credential lookup. Every
	// production repository implements the dedicated metadata-only policy query.
	if (typeof repos.byokKeys.shouldSuppressSharedCapacityForRequest !== 'function') {
		return { suppress: false, lookupFailed: false };
	}
	try {
		const suppress = await repos.byokKeys.shouldSuppressSharedCapacityForRequest({
			workspaceId: context.workspaceId,
			provider,
			modelId,
			userId: context.userId,
			apiKeyHash: context.apiKeyHash,
		});
		return { suppress, lookupFailed: false };
	} catch (error) {
		console.warn(JSON.stringify({
			message: 'private BYOK shared-capacity policy lookup failed',
			provider,
			model_id: modelId,
			error_kind: error instanceof Error ? error.name : 'unknown',
		}));
		return { suppress: false, lookupFailed: true };
	}
}

/**
 * Surround each already ordered route target's shared/platform credential group
 * with its eligible private BYOK credentials. Repository reads are cached per
 * provider/model pair for the lifetime of this request.
 */
export async function expandAttemptsWithPrivateByok(
	repos: GatewayRepositories,
	baseAttempts: RouteResult[],
	sharedAndPlatformAttempts: RouteResult[],
	context?: PrivateByokRequestContext | null,
): Promise<RouteResult[]> {
	const credentialAttemptsByTarget = new Map<string, RouteResult[]>();
	for (const attempt of sharedAndPlatformAttempts) {
		// A blank credential must never reach an egress driver.
		if (!attempt.providerApiKey.trim()) continue;
		const group = credentialAttemptsByTarget.get(attempt.targetId) ?? [];
		group.push(attempt);
		credentialAttemptsByTarget.set(attempt.targetId, group);
	}

	const keyPromises = new Map<
		string,
		Promise<{ keys: ByokRuntimeKeyRow[]; lookupFailed: boolean }>
	>();
	const sharedCapacityPolicyPromises = new Map<
		string,
		Promise<{ suppress: boolean; lookupFailed: boolean }>
	>();
	const primaryByokAttempts: RouteResult[] = [];
	const sharedAndPlatformSection: RouteResult[] = [];
	const fallbackByokAttempts: RouteResult[] = [];
	for (const route of baseAttempts) {
		const middle = credentialAttemptsByTarget.get(route.targetId) ?? [];
		let keys: ByokRuntimeKeyRow[] = [];
		let lookupFailed = false;
		let suppressSharedCapacity = false;
		if (context && route.gatewayPrivateByokDataPolicyAllowed !== false) {
			const provider = routeProviderSlug(route);
			const modelId = routeModelId(route);
			if (provider && modelId) {
				const cacheKey = `${provider}\u0000${modelId}`;
				let pending = keyPromises.get(cacheKey);
				if (!pending) {
					pending = loadPrivateKeys(repos, context, route);
					keyPromises.set(cacheKey, pending);
				}
				let policyPending = sharedCapacityPolicyPromises.get(cacheKey);
				if (!policyPending) {
					policyPending = loadSharedCapacityPolicy(repos, context, route);
					sharedCapacityPolicyPromises.set(cacheKey, policyPending);
				}
				const [lookup, policy] = await Promise.all([pending, policyPending]);
				keys = lookup.keys;
				lookupFailed = lookup.lookupFailed || policy.lookupFailed;
				suppressSharedCapacity = policy.suppress;
			}
		}
		for (const key of keys) {
			if (!key.is_fallback) {
				primaryByokAttempts.push(applyByokKeyToRoute(route, key));
			}
		}
		const suppressSameProviderCapacity = lookupFailed || suppressSharedCapacity || keys.some((key) =>
			!key.is_fallback
			&& (key.always_use_for_provider || key.always_use_for_matching_models)
		);
		if (!suppressSameProviderCapacity) sharedAndPlatformSection.push(...middle);
		for (const key of keys) {
			if (key.is_fallback) {
				fallbackByokAttempts.push(applyByokKeyToRoute(route, key));
			}
		}
	}
	return [
		...primaryByokAttempts,
		...sharedAndPlatformSection,
		...fallbackByokAttempts,
	];
}
