import type { MySqlDatabaseClient } from '../../storage/database-client';
import type { RouteDataPoliciesRepository } from '../../storage/gateway-repository-interfaces';
import {
	assertPolicyPrecondition,
	POLICY_COLUMNS,
	policyMySqlDate,
	policyPriorCondition,
	policySnapshot,
	policySubjectCondition,
	policyWriteValues,
} from '../route-data-policy-conditional-write';
import {
	RouteDataPolicyWriteConflictError,
	type RouteDataPolicyAdminRow,
	type RouteDataPolicyAuditRow,
	type RouteDataPolicyRow,
} from '../route-data-policy-types';
import { asMySqlPool, mysqlExecute } from './mysql2-compat';
import { withPolicyUtcConnection } from './route-data-policy-utc';

const COLUMNS = `route_target_id, subject_fingerprint, retention_days, training_allowed, zdr_supported, evidence_url, verified_by, verified_at, expires_at, status, invalidated_at, invalidation_reason, updated_at`;
const timestamp = (column: string) => `DATE_FORMAT(${column}, '%Y-%m-%dT%H:%i:%s.%fZ')`;
const readColumns = (alias: string) =>
	POLICY_COLUMNS.map((key) =>
		['verified_at', 'expires_at', 'invalidated_at', 'updated_at'].includes(key)
			? `${timestamp(`${alias}.${key}`)} AS ${key}`
			: `${alias}.${key}`,
	).join(', ');

export function createMySqlRouteDataPoliciesRepository(db: MySqlDatabaseClient): RouteDataPoliciesRepository {
	const pool = asMySqlPool(db.raw);
	const query = async <T>(sql: string, params: unknown[] = []) =>
		withPolicyUtcConnection(pool, async (connection) => (await connection.query(sql, params))[0] as T[]);
	const getByRouteTargetId = async (id: string) =>
		(await query<RouteDataPolicyRow>(`SELECT ${readColumns('p')} FROM route_data_policies p WHERE route_target_id = ?`, [id]))[0] ?? null;
	return {
		async listAll() {
			return query<RouteDataPolicyAdminRow>(
				`SELECT r.id AS route_target_id, p.subject_fingerprint, p.retention_days, COALESCE(p.training_allowed, 1) AS training_allowed, COALESCE(p.zdr_supported, 0) AS zdr_supported, p.evidence_url, p.verified_by, ${timestamp('p.verified_at')} AS verified_at, ${timestamp('p.expires_at')} AS expires_at, COALESCE(p.status, 'unknown') AS status, ${timestamp('p.invalidated_at')} AS invalidated_at, p.invalidation_reason, ${timestamp('COALESCE(p.updated_at, r.created_at)')} AS updated_at, r.model_id, r.provider_id, pr.name AS provider_name, r.provider_model_name, r.upstream_protocol, r.upstream_operation, r.route_group FROM model_routes r JOIN providers pr ON pr.id = r.provider_id LEFT JOIN route_data_policies p ON p.route_target_id = r.id ORDER BY pr.name, r.model_id, r.id`,
			);
		},
		async getByRouteTargetIds(ids) {
			if (ids.length === 0) return [];
			return query<RouteDataPolicyRow>(
				`SELECT ${readColumns('p')} FROM route_data_policies p WHERE route_target_id IN (${ids.map(() => '?').join(',')})`,
				ids,
			);
		},
		getByRouteTargetId,
		async listAudit(routeTargetId) {
			return query<RouteDataPolicyAuditRow>(
				`SELECT id, route_target_id, snapshot_json, actor_id, ${timestamp('created_at')} AS created_at FROM route_data_policy_audit WHERE route_target_id = ? ORDER BY created_at DESC, id DESC`,
				[routeTargetId],
			);
		},
		async upsertWithAudit(params) {
			await assertPolicyPrecondition(params);
			return withPolicyUtcConnection(
				pool,
				async (connection) => {
					const expected = params.precondition;
					if (expected) {
						// Same lock order as Postgres: provider, route, policy; all locks survive to commit.
						const [providers] = await connection.query<unknown[]>('SELECT id FROM providers WHERE BINARY id = BINARY ? FOR UPDATE', [
							expected.subjectReadSet.provider.id,
						]);
						if (providers.length !== 1) throw new RouteDataPolicyWriteConflictError();
						const subject = policySubjectCondition(expected, 'mysql');
						const [locked] = await connection.query<unknown[]>(
							`SELECT r.id FROM model_routes r JOIN providers pr ON pr.id=r.provider_id WHERE ${subject.sql} FOR UPDATE`,
							subject.values,
						);
						if (locked.length !== 1) throw new RouteDataPolicyWriteConflictError();
						if (expected.priorPolicy === null) {
							const [prior] = await connection.query<unknown[]>(
								'SELECT route_target_id FROM route_data_policies WHERE BINARY route_target_id = BINARY ? FOR UPDATE',
								[params.routeTargetId],
							);
							if (prior.length !== 0) throw new RouteDataPolicyWriteConflictError();
							try {
								const inserted = await mysqlExecute(
									connection,
									`INSERT INTO route_data_policies (${COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL,?)`,
									policyWriteValues(params, 'mysql'),
								);
								if (inserted.affectedRows !== 1) throw new Error('Invalid route data policy insert acknowledgement');
							} catch (error) {
								if (error && typeof error === 'object' && 'code' in error && error.code === 'ER_DUP_ENTRY')
									throw new RouteDataPolicyWriteConflictError();
								throw error;
							}
						} else {
							const prior = policyPriorCondition(expected.priorPolicy, 'mysql', 'p');
							const [matched] = await connection.query<unknown[]>(
								`SELECT p.route_target_id FROM route_data_policies p WHERE ${prior.sql} FOR UPDATE`,
								prior.values,
							);
							if (matched.length !== 1) throw new RouteDataPolicyWriteConflictError();
							const values = policyWriteValues(params, 'mysql');
							const updated = await mysqlExecute(
								connection,
								`UPDATE route_data_policies p SET subject_fingerprint=?, retention_days=?,
							training_allowed=?, zdr_supported=?, evidence_url=?, verified_by=?, verified_at=?, expires_at=?, status=?,
							invalidated_at=NULL, invalidation_reason=NULL, updated_at=? WHERE ${prior.sql}`,
								[...values.slice(1), ...prior.values],
							);
							// MySQL may report zero changed rows for an identical write; the matched row is already locked.
							if (updated.affectedRows !== 0 && updated.affectedRows !== 1)
								throw new Error('Invalid route data policy update acknowledgement');
						}
					} else {
						await connection.execute(
							`INSERT INTO route_data_policies (${COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL,?) ON DUPLICATE KEY UPDATE subject_fingerprint=VALUES(subject_fingerprint), retention_days=VALUES(retention_days), training_allowed=VALUES(training_allowed), zdr_supported=VALUES(zdr_supported), evidence_url=VALUES(evidence_url), verified_by=VALUES(verified_by), verified_at=VALUES(verified_at), expires_at=VALUES(expires_at), status=VALUES(status), invalidated_at=NULL, invalidation_reason=NULL, updated_at=VALUES(updated_at)`,
							policyWriteValues(params, 'mysql'),
						);
					}
					const [rows] = await connection.query<RouteDataPolicyRow[]>(
						`SELECT ${readColumns('p')} FROM route_data_policies p WHERE BINARY route_target_id = BINARY ?`,
						[params.routeTargetId],
					);
					if (rows.length !== 1 || rows[0]?.route_target_id !== params.routeTargetId)
						throw new Error('Invalid route data policy commit acknowledgement');
					const audit = await mysqlExecute(
						connection,
						`INSERT INTO route_data_policy_audit (id, route_target_id, snapshot_json, actor_id, created_at) VALUES (?,?,?,?,?)`,
						[params.id, params.routeTargetId, policySnapshot(params), params.actorId, policyMySqlDate(params.nowIso)],
					);
					if (audit.affectedRows !== 1) throw new Error('Invalid route data policy audit acknowledgement');
					return rows[0];
				},
				true,
			);
		},
		async invalidateForRouteTarget(routeTargetId, params) {
			return withPolicyUtcConnection(
				pool,
				async (connection) => {
					const audit = await mysqlExecute(
						connection,
						`INSERT INTO route_data_policy_audit (id, route_target_id, snapshot_json, actor_id, created_at)
					 SELECT ?, route_target_id, CAST(JSON_OBJECT('v', 2, 'event', 'invalidated', 'reason', ?, 'previous_status', status, 'subject_fingerprint', subject_fingerprint) AS CHAR), ?, ?
					 FROM route_data_policies WHERE route_target_id = ? AND status = 'verified' AND invalidated_at IS NULL`,
						[params.id, params.reason, params.actorId, policyMySqlDate(params.nowIso), routeTargetId],
					);
					const updated = await mysqlExecute(
						connection,
						`UPDATE route_data_policies SET status = 'unknown', verified_by = NULL, verified_at = NULL, invalidated_at = ?, invalidation_reason = ?, updated_at = ? WHERE route_target_id = ? AND status = 'verified' AND invalidated_at IS NULL`,
						[policyMySqlDate(params.nowIso), params.reason, policyMySqlDate(params.nowIso), routeTargetId],
					);
					if (audit.affectedRows !== updated.affectedRows) throw new Error('route data-policy invalidation audit mismatch');
					return updated.affectedRows;
				},
				true,
			);
		},
		async invalidateForProvider(providerId, params) {
			return withPolicyUtcConnection(
				pool,
				async (connection) => {
					const audit = await mysqlExecute(
						connection,
						`INSERT INTO route_data_policy_audit (id, route_target_id, snapshot_json, actor_id, created_at)
					 SELECT CONCAT(?, ':', SHA2(p.route_target_id, 256)), p.route_target_id, CAST(JSON_OBJECT('v', 2, 'event', 'invalidated', 'reason', ?, 'previous_status', p.status, 'subject_fingerprint', p.subject_fingerprint) AS CHAR), ?, ?
					 FROM route_data_policies p JOIN model_routes r ON r.id = p.route_target_id
					 WHERE r.provider_id = ? AND p.status = 'verified' AND p.invalidated_at IS NULL`,
						[params.id, params.reason, params.actorId, policyMySqlDate(params.nowIso), providerId],
					);
					const updated = await mysqlExecute(
						connection,
						`UPDATE route_data_policies p JOIN model_routes r ON r.id = p.route_target_id SET p.status = 'unknown', p.verified_by = NULL, p.verified_at = NULL, p.invalidated_at = ?, p.invalidation_reason = ?, p.updated_at = ? WHERE r.provider_id = ? AND p.status = 'verified' AND p.invalidated_at IS NULL`,
						[policyMySqlDate(params.nowIso), params.reason, policyMySqlDate(params.nowIso), providerId],
					);
					if (audit.affectedRows !== updated.affectedRows) throw new Error('provider data-policy invalidation audit mismatch');
					return updated.affectedRows;
				},
				true,
			);
		},
	};
}
