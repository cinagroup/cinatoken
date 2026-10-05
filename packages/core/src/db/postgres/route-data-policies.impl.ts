import type { PostgresDatabaseClient } from '../../storage/database-client';
import type { RouteDataPoliciesRepository } from '../../storage/gateway-repository-interfaces';
import {
	assertPolicyPrecondition,
	POLICY_COLUMNS,
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

const COLUMNS = `route_target_id, subject_fingerprint, retention_days, training_allowed, zdr_supported, evidence_url, verified_by, verified_at, expires_at, status, invalidated_at, invalidation_reason, updated_at`;
const timestamp = (column: string) => `pg_catalog.to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const readColumns = (alias: string) =>
	POLICY_COLUMNS.map((key) =>
		['verified_at', 'expires_at', 'invalidated_at', 'updated_at'].includes(key)
			? `${timestamp(`${alias}.${key}`)} AS ${key}`
			: `${alias}.${key}`,
	).join(', ');

export function createPostgresRouteDataPoliciesRepository(db: PostgresDatabaseClient): RouteDataPoliciesRepository {
	const pg = db.raw;
	const query = async <T>(sql: string, params: unknown[] = []) => (await pg.unsafe(sql, params as never[])) as unknown as T[];
	const getByRouteTargetId = async (id: string) =>
		(
			await query<RouteDataPolicyRow>(
				`SELECT ${readColumns('p')} FROM cinatoken_gateway.route_data_policies p WHERE route_target_id = $1`,
				[id],
			)
		)[0] ?? null;
	return {
		async listAll() {
			return query<RouteDataPolicyAdminRow>(
				`SELECT r.id AS route_target_id, p.subject_fingerprint, p.retention_days, COALESCE(p.training_allowed, TRUE) AS training_allowed, COALESCE(p.zdr_supported, FALSE) AS zdr_supported, p.evidence_url, p.verified_by, ${timestamp('p.verified_at')} AS verified_at, ${timestamp('p.expires_at')} AS expires_at, COALESCE(p.status, 'unknown') AS status, ${timestamp('p.invalidated_at')} AS invalidated_at, p.invalidation_reason, ${timestamp('COALESCE(p.updated_at, r.created_at)')} AS updated_at, r.model_id, r.provider_id, pr.name AS provider_name, r.provider_model_name, r.upstream_protocol, r.upstream_operation, r.route_group FROM cinatoken_gateway.model_routes r JOIN cinatoken_gateway.providers pr ON pr.id = r.provider_id LEFT JOIN cinatoken_gateway.route_data_policies p ON p.route_target_id = r.id ORDER BY pr.name, r.model_id, r.id`,
			);
		},
		// OID 25 is text: keep JSON bytes stable before SQL's jsonb cast,
		// including the shared raw client whose JSON serializer Drizzle changes.
		async getByRouteTargetIds(ids) {
			if (ids.length === 0) return [];
			return query<RouteDataPolicyRow>(
				`SELECT ${readColumns('p')} FROM cinatoken_gateway.route_data_policies p WHERE route_target_id IN (SELECT id FROM pg_catalog.jsonb_array_elements_text($1::jsonb) AS selected(id))`,
				[pg.typed(JSON.stringify(ids), 25)],
			);
		},
		getByRouteTargetId,
		async listAudit(routeTargetId) {
			return query<RouteDataPolicyAuditRow>(
				`SELECT id, route_target_id, snapshot_json, actor_id, ${timestamp('created_at')} AS created_at FROM cinatoken_gateway.route_data_policy_audit WHERE route_target_id = $1 ORDER BY created_at DESC, id DESC`,
				[routeTargetId],
			);
		},
		async upsertWithAudit(params) {
			await assertPolicyPrecondition(params);
			return pg.begin(async (tx) => {
				const expected = params.precondition;
				let rows: RouteDataPolicyRow[];
				if (expected) {
					// The consistent lock order is provider, route, policy; trust rows stay locked through commit.
					const providers = await tx.unsafe(`SELECT id FROM cinatoken_gateway.providers WHERE id COLLATE "C" = $1 COLLATE "C" FOR UPDATE`, [
						expected.subjectReadSet.provider.id,
					]);
					if (providers.length !== 1) throw new RouteDataPolicyWriteConflictError();
					const subject = policySubjectCondition(expected, 'postgres');
					const locked = await tx.unsafe(
						`SELECT r.id FROM cinatoken_gateway.model_routes r JOIN cinatoken_gateway.providers pr ON pr.id=r.provider_id WHERE ${subject.sql} FOR UPDATE OF r`,
						subject.values as never[],
					);
					if (locked.length !== 1) throw new RouteDataPolicyWriteConflictError();
					if (expected.priorPolicy === null) {
						// DO NOTHING protects the absent-policy case against a competing unique-key insert.
						rows = (await tx.unsafe(
							`INSERT INTO cinatoken_gateway.route_data_policies AS p (${COLUMNS})
							SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,NULL,$11
							WHERE NOT EXISTS (SELECT 1 FROM cinatoken_gateway.route_data_policies WHERE route_target_id=$1)
							ON CONFLICT(route_target_id) DO NOTHING RETURNING ${readColumns('p')}`,
							policyWriteValues(params, 'postgres') as never[],
						)) as unknown as RouteDataPolicyRow[];
					} else {
						const prior = policyPriorCondition(expected.priorPolicy, 'postgres', 'p', 12);
						rows = (await tx.unsafe(
							`UPDATE cinatoken_gateway.route_data_policies p SET subject_fingerprint=$2, retention_days=$3,
							training_allowed=$4, zdr_supported=$5, evidence_url=$6, verified_by=$7, verified_at=$8,
							expires_at=$9, status=$10, invalidated_at=NULL, invalidation_reason=NULL, updated_at=$11
							WHERE p.route_target_id=$1 AND ${prior.sql} RETURNING ${readColumns('p')}`,
							[...policyWriteValues(params, 'postgres'), ...prior.values] as never[],
						)) as unknown as RouteDataPolicyRow[];
					}
					if (rows.length !== 1) throw new RouteDataPolicyWriteConflictError();
				} else {
					rows = (await tx.unsafe(
						`INSERT INTO cinatoken_gateway.route_data_policies AS p (${COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,NULL,$11)
						ON CONFLICT(route_target_id) DO UPDATE SET subject_fingerprint=EXCLUDED.subject_fingerprint, retention_days=EXCLUDED.retention_days,
						training_allowed=EXCLUDED.training_allowed, zdr_supported=EXCLUDED.zdr_supported, evidence_url=EXCLUDED.evidence_url,
						verified_by=EXCLUDED.verified_by, verified_at=EXCLUDED.verified_at, expires_at=EXCLUDED.expires_at,
						status=EXCLUDED.status, invalidated_at=NULL, invalidation_reason=NULL, updated_at=EXCLUDED.updated_at RETURNING ${readColumns('p')}`,
						policyWriteValues(params, 'postgres') as never[],
					)) as unknown as RouteDataPolicyRow[];
				}
				if (rows.length !== 1 || rows[0]?.route_target_id !== params.routeTargetId)
					throw new Error('Invalid route data policy commit acknowledgement');
				await tx.unsafe(
					`INSERT INTO cinatoken_gateway.route_data_policy_audit (id, route_target_id, snapshot_json, actor_id, created_at) VALUES ($1,$2,$3,$4,$5)`,
					[params.id, params.routeTargetId, policySnapshot(params), params.actorId, params.nowIso],
				);
				return rows[0];
			});
		},
		async invalidateForRouteTarget(routeTargetId, params) {
			const rows = await query<{ route_target_id: string }>(
				`
				WITH invalidated AS (
					UPDATE cinatoken_gateway.route_data_policies
					SET status = 'unknown', verified_by = NULL, verified_at = NULL,
						invalidated_at = $1, invalidation_reason = $2, updated_at = $1
					WHERE route_target_id = $3 AND status = 'verified' AND invalidated_at IS NULL
					RETURNING route_target_id, subject_fingerprint
				)
				INSERT INTO cinatoken_gateway.route_data_policy_audit (id, route_target_id, snapshot_json, actor_id, created_at)
				SELECT $4, route_target_id, json_build_object('v', 2, 'event', 'invalidated', 'reason', $2::text, 'previous_status', 'verified', 'subject_fingerprint', subject_fingerprint)::text, $5, $1
				FROM invalidated RETURNING route_target_id
			`,
				[params.nowIso, params.reason, routeTargetId, params.id, params.actorId],
			);
			return rows.length;
		},
		async invalidateForProvider(providerId, params) {
			const rows = await query<{ route_target_id: string }>(
				`
				WITH invalidated AS (
					UPDATE cinatoken_gateway.route_data_policies p
					SET status = 'unknown', verified_by = NULL, verified_at = NULL,
						invalidated_at = $1, invalidation_reason = $2, updated_at = $1
					FROM cinatoken_gateway.model_routes r
					WHERE r.id = p.route_target_id AND r.provider_id = $3 AND p.status = 'verified' AND p.invalidated_at IS NULL
					RETURNING p.route_target_id, p.subject_fingerprint
				)
				INSERT INTO cinatoken_gateway.route_data_policy_audit (id, route_target_id, snapshot_json, actor_id, created_at)
				SELECT $4 || ':' || route_target_id, route_target_id, json_build_object('v', 2, 'event', 'invalidated', 'reason', $2::text, 'previous_status', 'verified', 'subject_fingerprint', subject_fingerprint)::text, $5, $1
				FROM invalidated RETURNING route_target_id
			`,
				[params.nowIso, params.reason, providerId, params.id, params.actorId],
			);
			return rows.length;
		},
	};
}
