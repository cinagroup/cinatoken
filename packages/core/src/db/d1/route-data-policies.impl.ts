import type { D1DatabaseClient } from '../../storage/database-client';
import type { RouteDataPoliciesRepository } from '../../storage/gateway-repository-interfaces';
import type { RouteDataPolicyAdminRow, RouteDataPolicyAuditRow, RouteDataPolicyRow } from '../route-data-policy-types';

const COLUMNS = `route_target_id, subject_fingerprint, retention_days, training_allowed, zdr_supported, evidence_url, verified_by, verified_at, expires_at, status, invalidated_at, invalidation_reason, updated_at`;

function invalidationSnapshotSql(): string {
	return `json_object('v', 2, 'event', 'invalidated', 'reason', ?, 'previous_status', status, 'subject_fingerprint', subject_fingerprint)`;
}

export function createD1RouteDataPoliciesRepository(db: D1DatabaseClient): RouteDataPoliciesRepository {
	const raw = db.raw;
	const getByRouteTargetId = async (id: string) => (await raw.prepare(`SELECT ${COLUMNS} FROM route_data_policies WHERE route_target_id = ?`).bind(id).first<RouteDataPolicyRow>()) ?? null;
	return {
		async listAll() {
			return (await raw.prepare(`SELECT r.id AS route_target_id, p.subject_fingerprint, p.retention_days, COALESCE(p.training_allowed, 1) AS training_allowed, COALESCE(p.zdr_supported, 0) AS zdr_supported, p.evidence_url, p.verified_by, p.verified_at, p.expires_at, COALESCE(p.status, 'unknown') AS status, p.invalidated_at, p.invalidation_reason, COALESCE(p.updated_at, r.created_at) AS updated_at, r.model_id, r.provider_id, pr.name AS provider_name, r.provider_model_name, r.upstream_protocol, r.upstream_operation, r.route_group FROM model_routes r JOIN providers pr ON pr.id = r.provider_id LEFT JOIN route_data_policies p ON p.route_target_id = r.id ORDER BY pr.name, r.model_id, r.id`).all<RouteDataPolicyAdminRow>()).results ?? [];
		},
		async getByRouteTargetIds(ids) {
			if (ids.length === 0) return [];
			const placeholders = ids.map(() => '?').join(',');
			return (await raw.prepare(`SELECT ${COLUMNS} FROM route_data_policies WHERE route_target_id IN (${placeholders})`).bind(...ids).all<RouteDataPolicyRow>()).results ?? [];
		},
		getByRouteTargetId,
		async listAudit(routeTargetId) { return (await raw.prepare(`SELECT id, route_target_id, snapshot_json, actor_id, created_at FROM route_data_policy_audit WHERE route_target_id = ? ORDER BY created_at DESC, id DESC`).bind(routeTargetId).all<RouteDataPolicyAuditRow>()).results ?? []; },
		async upsertWithAudit(params) {
			const snapshot = JSON.stringify({ v: 2, route_target_id: params.routeTargetId, subject_fingerprint: params.subjectFingerprint, retention_days: params.retentionDays, training_allowed: params.trainingAllowed, zdr_supported: params.zdrSupported, evidence_url: params.evidenceUrl, verified_by: params.verifiedBy, verified_at: params.verifiedAt, expires_at: params.expiresAt, status: params.status, invalidated_at: null, invalidation_reason: null });
			await raw.batch([
				raw.prepare(`INSERT INTO route_data_policies (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?) ON CONFLICT(route_target_id) DO UPDATE SET subject_fingerprint=excluded.subject_fingerprint, retention_days=excluded.retention_days, training_allowed=excluded.training_allowed, zdr_supported=excluded.zdr_supported, evidence_url=excluded.evidence_url, verified_by=excluded.verified_by, verified_at=excluded.verified_at, expires_at=excluded.expires_at, status=excluded.status, invalidated_at=NULL, invalidation_reason=NULL, updated_at=excluded.updated_at`).bind(params.routeTargetId, params.subjectFingerprint, params.retentionDays, params.trainingAllowed ? 1 : 0, params.zdrSupported ? 1 : 0, params.evidenceUrl, params.verifiedBy, params.verifiedAt, params.expiresAt, params.status, params.nowIso),
				raw.prepare(`INSERT INTO route_data_policy_audit (id, route_target_id, snapshot_json, actor_id, created_at) VALUES (?, ?, ?, ?, ?)`).bind(params.id, params.routeTargetId, snapshot, params.actorId, params.nowIso),
			]);
			const row = await getByRouteTargetId(params.routeTargetId); if (!row) throw new Error('route data policy upsert did not return a row'); return row;
		},
		async invalidateForRouteTarget(routeTargetId, params) {
			const results = await raw.batch([
				raw.prepare(`INSERT INTO route_data_policy_audit (id, route_target_id, snapshot_json, actor_id, created_at) SELECT ?, route_target_id, ${invalidationSnapshotSql()}, ?, ? FROM route_data_policies WHERE route_target_id = ? AND status = 'verified' AND invalidated_at IS NULL`).bind(params.id, params.reason, params.actorId, params.nowIso, routeTargetId),
				raw.prepare(`UPDATE route_data_policies SET status = 'unknown', verified_by = NULL, verified_at = NULL, invalidated_at = ?, invalidation_reason = ?, updated_at = ? WHERE route_target_id = ? AND status = 'verified' AND invalidated_at IS NULL`).bind(params.nowIso, params.reason, params.nowIso, routeTargetId),
			]);
			return results[1]?.meta.changes ?? 0;
		},
		async invalidateForProvider(providerId, params) {
			const results = await raw.batch([
				raw.prepare(`INSERT INTO route_data_policy_audit (id, route_target_id, snapshot_json, actor_id, created_at) SELECT ? || ':' || p.route_target_id, p.route_target_id, ${invalidationSnapshotSql()}, ?, ? FROM route_data_policies p JOIN model_routes r ON r.id = p.route_target_id WHERE r.provider_id = ? AND p.status = 'verified' AND p.invalidated_at IS NULL`).bind(params.id, params.reason, params.actorId, params.nowIso, providerId),
				raw.prepare(`UPDATE route_data_policies SET status = 'unknown', verified_by = NULL, verified_at = NULL, invalidated_at = ?, invalidation_reason = ?, updated_at = ? WHERE status = 'verified' AND invalidated_at IS NULL AND route_target_id IN (SELECT id FROM model_routes WHERE provider_id = ?)`).bind(params.nowIso, params.reason, params.nowIso, providerId),
			]);
			return results[1]?.meta.changes ?? 0;
		},
	};
}
