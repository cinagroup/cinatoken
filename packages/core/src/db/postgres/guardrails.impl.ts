import type { PostgresDatabaseClient } from '../../storage/database-client';
import type { GuardrailsRepository } from '../../storage/gateway-repository-interfaces';
import type { EffectiveGuardrailRow, GuardrailAssignmentRow, GuardrailVersionRow, GuardrailWithVersionRow } from '../guardrails-types';

const SELECT_DESIGNATED = `SELECT g.id, g.workspace_id, g.owner_user_id, g.name, g.description, g.status,
	g.designated_version, g.latest_version, g.created_at, g.updated_at,
	v.id AS version_id, v.config_json AS version_config_json,
	v.created_by_user_id AS version_created_by_user_id, v.created_at AS version_created_at
	FROM guardrails g JOIN guardrail_versions v ON v.guardrail_id = g.id AND v.version = g.designated_version`;

export function createPostgresGuardrailsRepository(db: PostgresDatabaseClient): GuardrailsRepository {
	const pg = db.raw;
	const query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => await pg.unsafe(sql, params as never[]) as unknown as T[];
	const getById = async (id: string) => (await query<GuardrailWithVersionRow>(`${SELECT_DESIGNATED} WHERE g.id = $1`, [id]))[0] ?? null;
	return {
		async listOwnedByWorkspace(workspaceId, userId, includeArchived = false) { return query(`${SELECT_DESIGNATED} WHERE g.workspace_id = $1 AND g.owner_user_id = $2${includeArchived ? '' : " AND g.status = 'active'"} ORDER BY g.updated_at DESC, g.id`, [workspaceId, userId]); },
		async listAll(includeArchived = false) { return query(`${SELECT_DESIGNATED}${includeArchived ? '' : " WHERE g.status = 'active'"} ORDER BY g.updated_at DESC, g.id`); },
		getById,
		async getByIdInWorkspace(id, workspaceId) { return (await query<GuardrailWithVersionRow>(`${SELECT_DESIGNATED} WHERE g.id = $1 AND g.workspace_id = $2`, [id, workspaceId]))[0] ?? null; },
		async listVersions(guardrailId) { return query<GuardrailVersionRow>(`SELECT id, guardrail_id, version, config_json, created_by_user_id, created_at FROM guardrail_versions WHERE guardrail_id = $1 ORDER BY version DESC`, [guardrailId]); },
		async listAssignments(guardrailId) { return query<GuardrailAssignmentRow>(`SELECT a.id, a.workspace_id, a.guardrail_id, a.scope_type, a.scope_id, a.created_by_user_id, a.created_at, g.name AS guardrail_name FROM guardrail_assignments a JOIN guardrails g ON g.id = a.guardrail_id WHERE a.guardrail_id = $1 ORDER BY a.scope_type, a.scope_id`, [guardrailId]); },
		async getEffectiveForRequest(workspaceId, userId, apiKeyId) { return query<EffectiveGuardrailRow>(`SELECT g.id, g.workspace_id, g.owner_user_id, g.name, g.description, g.status, g.designated_version, g.latest_version, g.created_at, g.updated_at, v.id AS version_id, v.config_json AS version_config_json, v.created_by_user_id AS version_created_by_user_id, v.created_at AS version_created_at, a.id AS assignment_id, a.scope_type AS assignment_scope_type, a.scope_id AS assignment_scope_id FROM guardrail_assignments a JOIN guardrails g ON g.id = a.guardrail_id AND g.workspace_id = a.workspace_id JOIN guardrail_versions v ON v.guardrail_id = g.id AND v.version = g.designated_version WHERE g.workspace_id = $1 AND g.status = 'active' AND ((a.scope_type = 'user' AND a.scope_id = $2) OR (a.scope_type = 'api_key' AND a.scope_id = $3)) ORDER BY a.scope_type, a.id`, [workspaceId, userId, apiKeyId]); },
		async createWithVersion(params) {
			await pg.begin(async (tx) => {
				await tx.unsafe(`INSERT INTO guardrails (id, workspace_id, owner_user_id, name, description, status, designated_version, latest_version, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, 'active', 1, 1, $6, $6)`, [params.id, params.workspaceId, params.ownerUserId, params.name, params.description, params.nowIso]);
				await tx.unsafe(`INSERT INTO guardrail_versions (id, guardrail_id, version, config_json, created_by_user_id, created_at) VALUES ($1, $2, 1, $3, $4, $5)`, [params.versionId, params.id, params.configJson, params.createdByUserId, params.nowIso]);
			});
			const row = await getById(params.id); if (!row) throw new Error('guardrail create did not return a row'); return row;
		},
		async addVersion(params) {
			const protection = params.preserveAdminManaged
				? ` AND NOT EXISTS (SELECT 1 FROM guardrail_assignments a WHERE a.guardrail_id = guardrails.id AND a.created_by_user_id IS NULL)`
				: '';
			let versionCreated = false;
			await pg.begin(async (tx) => {
				if (params.preserveAdminManaged) {
					const locked = await tx.unsafe<Array<{ id: string }>>(
						'SELECT id FROM guardrails WHERE id = $1 FOR UPDATE',
						[params.guardrailId],
					);
					if (!locked[0]) return;
				}
				const updated = await tx.unsafe<Array<{ latest_version: number }>>(`UPDATE guardrails SET latest_version = latest_version + 1, designated_version = latest_version + 1, name = $1, description = $2, updated_at = $3 WHERE id = $4 AND status = 'active'${protection} RETURNING latest_version`, [params.name, params.description, params.nowIso, params.guardrailId]);
				const version = updated[0]?.latest_version; if (!version) return;
				await tx.unsafe(`INSERT INTO guardrail_versions (id, guardrail_id, version, config_json, created_by_user_id, created_at) VALUES ($1, $2, $3, $4, $5, $6)`, [params.versionId, params.guardrailId, version, params.configJson, params.createdByUserId, params.nowIso]);
				versionCreated = true;
			});
			if (!versionCreated) return null;
			const row = await getById(params.guardrailId); if (!row) throw new Error('guardrail version create did not return a row'); return row;
		},
		async updateMetadata(id, patch) {
			const protection = patch.preserveAdminManaged
				? ` AND NOT EXISTS (SELECT 1 FROM guardrail_assignments a WHERE a.guardrail_id = guardrails.id AND a.created_by_user_id IS NULL)`
				: '';
			const values = [patch.name !== undefined, patch.name ?? '', patch.description !== undefined, patch.description ?? null, patch.status !== undefined, patch.status ?? 'active', patch.nowIso, id];
			if (!patch.preserveAdminManaged) {
				return Boolean((await query<{ id: string }>(`UPDATE guardrails SET name = CASE WHEN $1 THEN $2 ELSE name END, description = CASE WHEN $3 THEN $4 ELSE description END, status = CASE WHEN $5 THEN $6 ELSE status END, updated_at = $7 WHERE id = $8 RETURNING id`, values))[0]);
			}
			let updated = false;
			await pg.begin(async (tx) => {
				const locked = await tx.unsafe<Array<{ id: string }>>('SELECT id FROM guardrails WHERE id = $1 FOR UPDATE', [id]);
				if (!locked[0]) return;
				updated = Boolean((await tx.unsafe<Array<{ id: string }>>(`UPDATE guardrails SET name = CASE WHEN $1 THEN $2 ELSE name END, description = CASE WHEN $3 THEN $4 ELSE description END, status = CASE WHEN $5 THEN $6 ELSE status END, updated_at = $7 WHERE id = $8${protection} RETURNING id`, values))[0]);
			});
			return updated;
		},
		async designateVersion(id, version, nowIso, options) {
			const protection = options?.preserveAdminManaged
				? ` AND NOT EXISTS (SELECT 1 FROM guardrail_assignments a WHERE a.guardrail_id = guardrails.id AND a.created_by_user_id IS NULL)`
				: '';
			const values = [version, nowIso, id];
			const statement = `UPDATE guardrails SET designated_version = $1, updated_at = $2 WHERE id = $3 AND status = 'active' AND EXISTS (SELECT 1 FROM guardrail_versions v WHERE v.guardrail_id = guardrails.id AND v.version = $1)${protection} RETURNING id`;
			if (!options?.preserveAdminManaged) return Boolean((await query<{ id: string }>(statement, values))[0]);
			let updated = false;
			await pg.begin(async (tx) => {
				const locked = await tx.unsafe<Array<{ id: string }>>('SELECT id FROM guardrails WHERE id = $1 FOR UPDATE', [id]);
				if (!locked[0]) return;
				updated = Boolean((await tx.unsafe<Array<{ id: string }>>(statement, values))[0]);
			});
			return updated;
		},
		async upsertAssignment(params) {
			const protection = params.preserveAdminManaged ? ' WHERE guardrail_assignments.created_by_user_id IS NOT NULL' : '';
			let assignment: GuardrailAssignmentRow | null = null;
			await pg.begin(async (tx) => {
				const locked = await tx.unsafe<Array<{ id: string }>>(
					'SELECT id FROM guardrails WHERE id = $1 FOR UPDATE',
					[params.guardrailId],
				);
				if (!locked[0]) throw new Error('guardrail assignment target does not exist');
				const rows = await tx.unsafe<GuardrailAssignmentRow[]>(`INSERT INTO guardrail_assignments (id, workspace_id, guardrail_id, scope_type, scope_id, created_by_user_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (workspace_id, scope_type, scope_id) DO UPDATE SET guardrail_id = EXCLUDED.guardrail_id, created_by_user_id = EXCLUDED.created_by_user_id, created_at = EXCLUDED.created_at${protection} RETURNING id, workspace_id, guardrail_id, scope_type, scope_id, created_by_user_id, created_at`, [params.id, params.workspaceId, params.guardrailId, params.scopeType, params.scopeId, params.createdByUserId, params.nowIso]);
				assignment = rows[0] ?? (await tx.unsafe<GuardrailAssignmentRow[]>(`SELECT id, workspace_id, guardrail_id, scope_type, scope_id, created_by_user_id, created_at FROM guardrail_assignments WHERE workspace_id = $1 AND scope_type = $2 AND scope_id = $3`, [params.workspaceId, params.scopeType, params.scopeId]))[0] ?? null;
			});
			if (!assignment) throw new Error('guardrail assignment did not return a row');
			return assignment;
		},
		async deleteAssignment(workspaceId, scopeType, scopeId, createdByUserId) {
			const values = createdByUserId === undefined ? [workspaceId, scopeType, scopeId] : [workspaceId, scopeType, scopeId, createdByUserId];
			const ownerClause = createdByUserId === undefined ? '' : ' AND created_by_user_id = $4';
			return Boolean((await query<{ id: string }>(`DELETE FROM guardrail_assignments WHERE workspace_id = $1 AND scope_type = $2 AND scope_id = $3${ownerClause} RETURNING id`, values))[0]);
		},
		async getSettledBudgetSpent(workspaceId, scopeType, scopeId, sinceIso) {
			const column = scopeType === 'user' ? 'user_id' : 'api_key_id'; const row = (await query<{ spent: string | number }>(`SELECT COALESCE(SUM(l.charged_cost), 0) AS spent FROM api_key_request_logs l WHERE l.${column} = $1 AND l.created_at >= $2 AND EXISTS (SELECT 1 FROM api_keys k WHERE k.id = l.api_key_id AND k.workspace_id = $3)`, [scopeId, sinceIso, workspaceId]))[0]; return Number(row?.spent ?? 0);
		},
	};
}
