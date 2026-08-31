import type { MySqlDatabaseClient } from '../../storage/database-client';
import type { RouteDataPoliciesRepository } from '../../storage/gateway-repository-interfaces';
import type { RouteDataPolicyAdminRow, RouteDataPolicyAuditRow, RouteDataPolicyRow } from '../route-data-policy-types';
import { asMySqlPool, mysqlExecute } from './mysql2-compat';

const COLUMNS = `route_target_id, subject_fingerprint, retention_days, training_allowed, zdr_supported, evidence_url, verified_by, verified_at, expires_at, status, invalidated_at, invalidation_reason, updated_at`;

export function createMySqlRouteDataPoliciesRepository(db: MySqlDatabaseClient): RouteDataPoliciesRepository {
	const pool = asMySqlPool(db.raw);
	const query = async <T>(sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
	const getByRouteTargetId = async (id: string) => (await query<RouteDataPolicyRow>(`SELECT ${COLUMNS} FROM route_data_policies WHERE route_target_id = ?`, [id]))[0] ?? null;
	return {
		async listAll() { return query<RouteDataPolicyAdminRow>(`SELECT r.id AS route_target_id, p.subject_fingerprint, p.retention_days, COALESCE(p.training_allowed, 1) AS training_allowed, COALESCE(p.zdr_supported, 0) AS zdr_supported, p.evidence_url, p.verified_by, p.verified_at, p.expires_at, COALESCE(p.status, 'unknown') AS status, p.invalidated_at, p.invalidation_reason, COALESCE(p.updated_at, r.created_at) AS updated_at, r.model_id, r.provider_id, pr.name AS provider_name, r.provider_model_name, r.upstream_protocol, r.upstream_operation, r.route_group FROM model_routes r JOIN providers pr ON pr.id = r.provider_id LEFT JOIN route_data_policies p ON p.route_target_id = r.id ORDER BY pr.name, r.model_id, r.id`); },
		async getByRouteTargetIds(ids) { if (ids.length === 0) return []; return query<RouteDataPolicyRow>(`SELECT ${COLUMNS} FROM route_data_policies WHERE route_target_id IN (${ids.map(() => '?').join(',')})`, ids); },
		getByRouteTargetId,
		async listAudit(routeTargetId) { return query<RouteDataPolicyAuditRow>(`SELECT id, route_target_id, snapshot_json, actor_id, created_at FROM route_data_policy_audit WHERE route_target_id = ? ORDER BY created_at DESC, id DESC`, [routeTargetId]); },
		async upsertWithAudit(params) {
			const snapshot = JSON.stringify({ v: 2, route_target_id: params.routeTargetId, subject_fingerprint: params.subjectFingerprint, retention_days: params.retentionDays, training_allowed: params.trainingAllowed, zdr_supported: params.zdrSupported, evidence_url: params.evidenceUrl, verified_by: params.verifiedBy, verified_at: params.verifiedAt, expires_at: params.expiresAt, status: params.status, invalidated_at: null, invalidation_reason: null });
			const connection = await pool.getConnection(); try { await connection.beginTransaction(); await connection.execute(`INSERT INTO route_data_policies (${COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL,?) ON DUPLICATE KEY UPDATE subject_fingerprint=VALUES(subject_fingerprint), retention_days=VALUES(retention_days), training_allowed=VALUES(training_allowed), zdr_supported=VALUES(zdr_supported), evidence_url=VALUES(evidence_url), verified_by=VALUES(verified_by), verified_at=VALUES(verified_at), expires_at=VALUES(expires_at), status=VALUES(status), invalidated_at=NULL, invalidation_reason=NULL, updated_at=VALUES(updated_at)`, [params.routeTargetId, params.subjectFingerprint, params.retentionDays, params.trainingAllowed, params.zdrSupported, params.evidenceUrl, params.verifiedBy, params.verifiedAt, params.expiresAt, params.status, params.nowIso]); await connection.execute(`INSERT INTO route_data_policy_audit (id, route_target_id, snapshot_json, actor_id, created_at) VALUES (?,?,?,?,?)`, [params.id, params.routeTargetId, snapshot, params.actorId, params.nowIso]); await connection.commit(); } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
			const row = await getByRouteTargetId(params.routeTargetId); if (!row) throw new Error('route data policy upsert did not return a row'); return row;
		},
		async invalidateForRouteTarget(routeTargetId, params) {
			const connection = await pool.getConnection();
			try {
				await connection.beginTransaction();
				const audit = await mysqlExecute(connection,
					`INSERT INTO route_data_policy_audit (id, route_target_id, snapshot_json, actor_id, created_at)
					 SELECT ?, route_target_id, CAST(JSON_OBJECT('v', 2, 'event', 'invalidated', 'reason', ?, 'previous_status', status, 'subject_fingerprint', subject_fingerprint) AS CHAR), ?, ?
					 FROM route_data_policies WHERE route_target_id = ? AND status = 'verified' AND invalidated_at IS NULL`,
					[params.id, params.reason, params.actorId, params.nowIso, routeTargetId],
				);
				const updated = await mysqlExecute(connection, `UPDATE route_data_policies SET status = 'unknown', verified_by = NULL, verified_at = NULL, invalidated_at = ?, invalidation_reason = ?, updated_at = ? WHERE route_target_id = ? AND status = 'verified' AND invalidated_at IS NULL`, [params.nowIso, params.reason, params.nowIso, routeTargetId]);
				if (audit.affectedRows !== updated.affectedRows) throw new Error('route data-policy invalidation audit mismatch');
				await connection.commit();
				return updated.affectedRows;
			} catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
		},
		async invalidateForProvider(providerId, params) {
			const connection = await pool.getConnection();
			try {
				await connection.beginTransaction();
				const audit = await mysqlExecute(connection,
					`INSERT INTO route_data_policy_audit (id, route_target_id, snapshot_json, actor_id, created_at)
					 SELECT CONCAT(?, ':', SHA2(p.route_target_id, 256)), p.route_target_id, CAST(JSON_OBJECT('v', 2, 'event', 'invalidated', 'reason', ?, 'previous_status', p.status, 'subject_fingerprint', p.subject_fingerprint) AS CHAR), ?, ?
					 FROM route_data_policies p JOIN model_routes r ON r.id = p.route_target_id
					 WHERE r.provider_id = ? AND p.status = 'verified' AND p.invalidated_at IS NULL`,
					[params.id, params.reason, params.actorId, params.nowIso, providerId],
				);
				const updated = await mysqlExecute(connection, `UPDATE route_data_policies p JOIN model_routes r ON r.id = p.route_target_id SET p.status = 'unknown', p.verified_by = NULL, p.verified_at = NULL, p.invalidated_at = ?, p.invalidation_reason = ?, p.updated_at = ? WHERE r.provider_id = ? AND p.status = 'verified' AND p.invalidated_at IS NULL`, [params.nowIso, params.reason, params.nowIso, providerId]);
				if (audit.affectedRows !== updated.affectedRows) throw new Error('provider data-policy invalidation audit mismatch');
				await connection.commit();
				return updated.affectedRows;
			} catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
		},
	};
}
