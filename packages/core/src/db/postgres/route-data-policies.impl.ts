import type { PostgresDatabaseClient } from '../../storage/database-client';
import type { RouteDataPoliciesRepository } from '../../storage/gateway-repository-interfaces';
import type { RouteDataPolicyAdminRow, RouteDataPolicyAuditRow, RouteDataPolicyRow } from '../route-data-policy-types';

const COLUMNS = `route_target_id, subject_fingerprint, retention_days, training_allowed, zdr_supported, evidence_url, verified_by, verified_at, expires_at, status, invalidated_at, invalidation_reason, updated_at`;

export function createPostgresRouteDataPoliciesRepository(db: PostgresDatabaseClient): RouteDataPoliciesRepository {
	const pg = db.raw;
	const query = async <T>(sql: string, params: unknown[] = []) => await pg.unsafe(sql, params as never[]) as unknown as T[];
	const getByRouteTargetId = async (id: string) => (await query<RouteDataPolicyRow>(`SELECT ${COLUMNS} FROM route_data_policies WHERE route_target_id = $1`, [id]))[0] ?? null;
	return {
		async listAll() { return query<RouteDataPolicyAdminRow>(`SELECT r.id AS route_target_id, p.subject_fingerprint, p.retention_days, COALESCE(p.training_allowed, TRUE) AS training_allowed, COALESCE(p.zdr_supported, FALSE) AS zdr_supported, p.evidence_url, p.verified_by, p.verified_at, p.expires_at, COALESCE(p.status, 'unknown') AS status, p.invalidated_at, p.invalidation_reason, COALESCE(p.updated_at, r.created_at) AS updated_at, r.model_id, r.provider_id, pr.name AS provider_name, r.provider_model_name, r.upstream_protocol, r.upstream_operation, r.route_group FROM model_routes r JOIN providers pr ON pr.id = r.provider_id LEFT JOIN route_data_policies p ON p.route_target_id = r.id ORDER BY pr.name, r.model_id, r.id`); },
		async getByRouteTargetIds(ids) { if (ids.length === 0) return []; return query<RouteDataPolicyRow>(`SELECT ${COLUMNS} FROM route_data_policies WHERE route_target_id = ANY($1::text[])`, [ids]); },
		getByRouteTargetId,
		async listAudit(routeTargetId) { return query<RouteDataPolicyAuditRow>(`SELECT id, route_target_id, snapshot_json, actor_id, created_at FROM route_data_policy_audit WHERE route_target_id = $1 ORDER BY created_at DESC, id DESC`, [routeTargetId]); },
		async upsertWithAudit(params) {
			const snapshot = JSON.stringify({ v: 2, route_target_id: params.routeTargetId, subject_fingerprint: params.subjectFingerprint, retention_days: params.retentionDays, training_allowed: params.trainingAllowed, zdr_supported: params.zdrSupported, evidence_url: params.evidenceUrl, verified_by: params.verifiedBy, verified_at: params.verifiedAt, expires_at: params.expiresAt, status: params.status, invalidated_at: null, invalidation_reason: null });
			await pg.begin(async (tx) => {
				await tx.unsafe(`INSERT INTO route_data_policies (${COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,NULL,$11) ON CONFLICT(route_target_id) DO UPDATE SET subject_fingerprint=EXCLUDED.subject_fingerprint, retention_days=EXCLUDED.retention_days, training_allowed=EXCLUDED.training_allowed, zdr_supported=EXCLUDED.zdr_supported, evidence_url=EXCLUDED.evidence_url, verified_by=EXCLUDED.verified_by, verified_at=EXCLUDED.verified_at, expires_at=EXCLUDED.expires_at, status=EXCLUDED.status, invalidated_at=NULL, invalidation_reason=NULL, updated_at=EXCLUDED.updated_at`, [params.routeTargetId, params.subjectFingerprint, params.retentionDays, params.trainingAllowed, params.zdrSupported, params.evidenceUrl, params.verifiedBy, params.verifiedAt, params.expiresAt, params.status, params.nowIso]);
				await tx.unsafe(`INSERT INTO route_data_policy_audit (id, route_target_id, snapshot_json, actor_id, created_at) VALUES ($1,$2,$3,$4,$5)`, [params.id, params.routeTargetId, snapshot, params.actorId, params.nowIso]);
			});
			const row = await getByRouteTargetId(params.routeTargetId); if (!row) throw new Error('route data policy upsert did not return a row'); return row;
		},
		async invalidateForRouteTarget(routeTargetId, params) {
			const rows = await query<{ route_target_id: string }>(`
				WITH invalidated AS (
					UPDATE route_data_policies
					SET status = 'unknown', verified_by = NULL, verified_at = NULL,
						invalidated_at = $1, invalidation_reason = $2, updated_at = $1
					WHERE route_target_id = $3 AND status = 'verified' AND invalidated_at IS NULL
					RETURNING route_target_id, subject_fingerprint
				)
				INSERT INTO route_data_policy_audit (id, route_target_id, snapshot_json, actor_id, created_at)
				SELECT $4, route_target_id, json_build_object('v', 2, 'event', 'invalidated', 'reason', $2::text, 'previous_status', 'verified', 'subject_fingerprint', subject_fingerprint)::text, $5, $1
				FROM invalidated RETURNING route_target_id
			`, [params.nowIso, params.reason, routeTargetId, params.id, params.actorId]);
			return rows.length;
		},
		async invalidateForProvider(providerId, params) {
			const rows = await query<{ route_target_id: string }>(`
				WITH invalidated AS (
					UPDATE route_data_policies p
					SET status = 'unknown', verified_by = NULL, verified_at = NULL,
						invalidated_at = $1, invalidation_reason = $2, updated_at = $1
					FROM model_routes r
					WHERE r.id = p.route_target_id AND r.provider_id = $3 AND p.status = 'verified' AND p.invalidated_at IS NULL
					RETURNING p.route_target_id, p.subject_fingerprint
				)
				INSERT INTO route_data_policy_audit (id, route_target_id, snapshot_json, actor_id, created_at)
				SELECT $4 || ':' || route_target_id, route_target_id, json_build_object('v', 2, 'event', 'invalidated', 'reason', $2::text, 'previous_status', 'verified', 'subject_fingerprint', subject_fingerprint)::text, $5, $1
				FROM invalidated RETURNING route_target_id
			`, [params.nowIso, params.reason, providerId, params.id, params.actorId]);
			return rows.length;
		},
	};
}
