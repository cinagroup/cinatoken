import type { RouteDataPolicyRow, RouteDataPolicyStatus } from './db/route-data-policy-types';
import { parseProviderEndpoints, type ProviderEndpointsMap } from './provider-endpoints';
import type { ModelRouteRow, ProviderRow } from './types';

const SUBJECT_FINGERPRINT_RE = /^[0-9a-f]{64}$/u;

function flag(value: number | boolean): boolean {
	return value === true || value === 1;
}

function canonicalize(value: unknown): unknown {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new TypeError('route data-policy subject contains a non-finite number');
		return Object.is(value, -0) ? 0 : value;
	}
	if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
	if (typeof value === 'object') {
		// A null prototype preserves JSON keys such as `__proto__` as ordinary
		// subject data instead of invoking Object.prototype's legacy setter.
		const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			const entry = (value as Record<string, unknown>)[key];
			if (entry !== undefined) result[key] = canonicalize(entry);
		}
		return result;
	}
	throw new TypeError(`route data-policy subject contains unsupported ${typeof value}`);
}

async function sha256Hex(value: string): Promise<string> {
	const bytes = new TextEncoder().encode(value);
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseCustomParams(raw: string | null | undefined): Record<string, unknown> | null {
	if (!raw) return null;
	try {
		const value = JSON.parse(raw) as unknown;
		return value && typeof value === 'object' && !Array.isArray(value)
			? value as Record<string, unknown>
			: null;
	} catch {
		// Runtime route resolution also ignores malformed legacy custom_params.
		return null;
	}
}

export type RouteDataPolicySubjectInput = {
	providerId: string;
	providerEndpoints: ProviderEndpointsMap;
	/** Raw server-side credential. It is hashed before entering the canonical subject. */
	providerCredential: string;
	providerSharedChannelType: string | null;
	providerModelName: string;
	upstreamProtocol: string;
	configuredUpstreamOperation: string;
	adapter: string;
	customParams: Record<string, unknown> | null;
};

/**
 * Bind a policy assertion to every route/provider field that can change the
 * upstream data processor or payload. Only SHA-256 output is persisted; raw
 * credentials and canonical subject JSON never leave process memory.
 */
export async function computeRouteDataPolicySubjectFingerprint(
	input: RouteDataPolicySubjectInput,
): Promise<string> {
	const protocol = input.upstreamProtocol.trim().toLowerCase();
	const credentialSha256 = await sha256Hex(input.providerCredential);
	const subject = canonicalize({
		version: 'cinatoken.route-data-policy-subject.v1',
		provider_id: input.providerId,
		provider_endpoint: input.providerEndpoints[protocol as keyof ProviderEndpointsMap] ?? null,
		provider_credential_sha256: credentialSha256,
		provider_shared_channel_type: input.providerSharedChannelType?.trim() || null,
		provider_model_name: input.providerModelName,
		upstream_protocol: protocol,
		configured_upstream_operation: input.configuredUpstreamOperation.trim() || '*',
		adapter: input.adapter.trim() || 'passthrough',
		custom_params: input.customParams,
	});
	return sha256Hex(JSON.stringify(subject));
}

/** Compute the verification subject directly from authoritative database rows. */
export function computeRouteDataPolicySubjectFingerprintFromRows(
	route: Pick<ModelRouteRow,
		'provider_id' | 'provider_model_name' | 'custom_params' | 'upstream_protocol' | 'upstream_operation' | 'adapter'>,
	provider: Pick<ProviderRow, 'id' | 'endpoints' | 'api_key' | 'shared_channel_type'>,
): Promise<string> {
	if (route.provider_id !== provider.id) {
		throw new Error('route data-policy subject provider mismatch');
	}
	return computeRouteDataPolicySubjectFingerprint({
		providerId: provider.id,
		providerEndpoints: parseProviderEndpoints(provider),
		providerCredential: provider.api_key ?? '',
		providerSharedChannelType: provider.shared_channel_type ?? null,
		providerModelName: route.provider_model_name,
		upstreamProtocol: route.upstream_protocol,
		configuredUpstreamOperation: route.upstream_operation ?? '*',
		adapter: route.adapter ?? 'passthrough',
		customParams: parseCustomParams(route.custom_params),
	});
}

export function routeDataPolicySubjectMatches(
	row: RouteDataPolicyRow | null | undefined,
	currentSubjectFingerprint: string | null | undefined,
): boolean {
	const asserted = row?.subject_fingerprint?.trim().toLowerCase() ?? '';
	const current = currentSubjectFingerprint?.trim().toLowerCase() ?? '';
	return SUBJECT_FINGERPRINT_RE.test(asserted)
		&& SUBJECT_FINGERPRINT_RE.test(current)
		&& asserted === current;
}

export function effectiveRouteDataPolicyStatus(
	row: RouteDataPolicyRow | null | undefined,
	now = new Date(),
): RouteDataPolicyStatus {
	if (!row) return 'unknown';
	if (row.status === 'expired') return 'expired';
	if (row.invalidated_at || row.invalidation_reason) return 'unknown';
	if (
		row.status !== 'verified'
		|| !row.evidence_url
		|| !row.verified_at
		|| !row.expires_at
		|| !SUBJECT_FINGERPRINT_RE.test(row.subject_fingerprint ?? '')
	) return 'unknown';
	const expires = Date.parse(row.expires_at);
	if (!Number.isFinite(expires) || expires <= now.getTime()) return 'expired';
	return 'verified';
}

export function effectiveRouteDataPolicyStatusForSubject(
	row: RouteDataPolicyRow | null | undefined,
	currentSubjectFingerprint: string | null | undefined,
	now = new Date(),
): RouteDataPolicyStatus {
	const effective = effectiveRouteDataPolicyStatus(row, now);
	return effective === 'verified' && !routeDataPolicySubjectMatches(row, currentSubjectFingerprint)
		? 'unknown'
		: effective;
}

/** ZDR requires an active assertion for this exact subject, zero retention, no training, and explicit support. */
export function routeDataPolicyAllowsZdr(
	row: RouteDataPolicyRow | null | undefined,
	currentSubjectFingerprint: string | null | undefined,
	now = new Date(),
): boolean {
	return effectiveRouteDataPolicyStatusForSubject(row, currentSubjectFingerprint, now) === 'verified'
		&& row?.retention_days === 0
		&& !flag(row.training_allowed)
		&& flag(row.zdr_supported);
}

/** `data_collection=deny` requires current evidence for this exact subject of no retention and no training. */
export function routeDataPolicyDeniesCollection(
	row: RouteDataPolicyRow | null | undefined,
	currentSubjectFingerprint: string | null | undefined,
	now = new Date(),
): boolean {
	return effectiveRouteDataPolicyStatusForSubject(row, currentSubjectFingerprint, now) === 'verified'
		&& row?.retention_days === 0
		&& !flag(row.training_allowed);
}
