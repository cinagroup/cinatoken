import type { ModelRouteRow, ProviderRow } from '../types';

export type RouteDataPolicyStatus = 'verified' | 'expired' | 'unknown';

/** Only server-resolved rows may enter this read-set. Credential bytes never leave the server. */
export type RouteDataPolicyWritePrecondition = {
	currentSubjectFingerprint: string;
	subjectReadSet: {
		route: Pick<
			ModelRouteRow,
			'id' | 'provider_id' | 'provider_model_name' | 'upstream_protocol' | 'upstream_operation' | 'adapter' | 'custom_params'
		>;
		provider: Pick<ProviderRow, 'id' | 'endpoints' | 'api_key' | 'shared_channel_type'>;
	};
	/** Explicit null means the policy did not exist. This is current-value CAS, not a historical revision. */
	priorPolicy: RouteDataPolicyRow | null;
};

export class RouteDataPolicyWriteConflictError extends Error {
	readonly code = 'route_data_policy_write_conflict';
	constructor() {
		super('Route data policy or its trust subject changed');
	}
}

export type RouteDataPolicyRow = {
	route_target_id: string;
	/** SHA-256 of the exact route/provider trust subject verified by an administrator. */
	subject_fingerprint: string | null;
	retention_days: number | null;
	training_allowed: number | boolean;
	zdr_supported: number | boolean;
	evidence_url: string | null;
	verified_by: string | null;
	verified_at: string | null;
	expires_at: string | null;
	status: RouteDataPolicyStatus;
	/** Set when a trust-relevant route or provider mutation invalidates this assertion. */
	invalidated_at: string | null;
	invalidation_reason: string | null;
	updated_at: string;
};

export type RouteDataPolicyAdminRow = RouteDataPolicyRow & {
	model_id: string;
	provider_id: string;
	provider_name: string;
	provider_model_name: string;
	upstream_protocol: string;
	upstream_operation: string | null;
	route_group: string | null;
};

export type RouteDataPolicyAuditRow = {
	id: string;
	route_target_id: string | null;
	snapshot_json: string;
	actor_id: string;
	created_at: string;
};

export type UpsertRouteDataPolicyParams = {
	id: string;
	routeTargetId: string;
	subjectFingerprint: string;
	retentionDays: number | null;
	trainingAllowed: boolean;
	zdrSupported: boolean;
	evidenceUrl: string | null;
	verifiedBy: string | null;
	verifiedAt: string | null;
	expiresAt: string | null;
	status: RouteDataPolicyStatus;
	actorId: string;
	nowIso: string;
	/** Missing only for compatible legacy writers. Every provided read-set is checked atomically. */
	precondition?: RouteDataPolicyWritePrecondition;
};

export type InvalidateRouteDataPoliciesParams = {
	id: string;
	actorId: string;
	nowIso: string;
	reason: string;
};
