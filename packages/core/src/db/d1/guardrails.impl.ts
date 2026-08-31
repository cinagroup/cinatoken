import type { D1DatabaseClient } from '../../storage/database-client';
import type { GuardrailsRepository } from '../../storage/gateway-repository-interfaces';
import type { EffectiveGuardrailRow, GuardrailAssignmentRow, GuardrailVersionRow, GuardrailWithVersionRow } from '../guardrails-types';

const SELECT_DESIGNATED = `SELECT g.id, g.workspace_id, g.owner_user_id, g.name, g.description, g.status,
	g.designated_version, g.latest_version, g.created_at, g.updated_at,
	v.id AS version_id, v.config_json AS version_config_json,
	v.created_by_user_id AS version_created_by_user_id, v.created_at AS version_created_at
	FROM guardrails g JOIN guardrail_versions v
	ON v.guardrail_id = g.id AND v.version = g.designated_version`;

export function createD1GuardrailsRepository(db: D1DatabaseClient): GuardrailsRepository {
	const raw = db.raw;
	const getById = async (id: string): Promise<GuardrailWithVersionRow | null> =>
		(await raw.prepare(`${SELECT_DESIGNATED} WHERE g.id = ?`).bind(id).first<GuardrailWithVersionRow>()) ?? null;
	return {
		async listOwnedByWorkspace(workspaceId, userId, includeArchived = false) {
			const status = includeArchived ? '' : " AND g.status = 'active'";
			return (await raw.prepare(`${SELECT_DESIGNATED} WHERE g.workspace_id = ? AND g.owner_user_id = ?${status} ORDER BY g.updated_at DESC, g.id`).bind(workspaceId, userId).all<GuardrailWithVersionRow>()).results ?? [];
		},
		async listAll(includeArchived = false) {
			const status = includeArchived ? '' : " WHERE g.status = 'active'";
			return (await raw.prepare(`${SELECT_DESIGNATED}${status} ORDER BY g.updated_at DESC, g.id`).all<GuardrailWithVersionRow>()).results ?? [];
		},
		getById,
		async getByIdInWorkspace(id, workspaceId) {
			return (await raw.prepare(`${SELECT_DESIGNATED} WHERE g.id = ? AND g.workspace_id = ?`).bind(id, workspaceId).first<GuardrailWithVersionRow>()) ?? null;
		},
		async listVersions(guardrailId) {
			return (await raw.prepare(`SELECT id, guardrail_id, version, config_json, created_by_user_id, created_at FROM guardrail_versions WHERE guardrail_id = ? ORDER BY version DESC`).bind(guardrailId).all<GuardrailVersionRow>()).results ?? [];
		},
		async listAssignments(guardrailId) {
			return (await raw.prepare(`SELECT a.id, a.workspace_id, a.guardrail_id, a.scope_type, a.scope_id, a.created_by_user_id, a.created_at, g.name AS guardrail_name FROM guardrail_assignments a JOIN guardrails g ON g.id = a.guardrail_id WHERE a.guardrail_id = ? ORDER BY a.scope_type, a.scope_id`).bind(guardrailId).all<GuardrailAssignmentRow>()).results ?? [];
		},
		async getEffectiveForRequest(workspaceId, userId, apiKeyId) {
			return (await raw.prepare(`SELECT g.id, g.workspace_id, g.owner_user_id, g.name, g.description, g.status, g.designated_version, g.latest_version, g.created_at, g.updated_at, v.id AS version_id, v.config_json AS version_config_json, v.created_by_user_id AS version_created_by_user_id, v.created_at AS version_created_at, a.id AS assignment_id, a.scope_type AS assignment_scope_type, a.scope_id AS assignment_scope_id FROM guardrail_assignments a JOIN guardrails g ON g.id = a.guardrail_id AND g.workspace_id = a.workspace_id JOIN guardrail_versions v ON v.guardrail_id = g.id AND v.version = g.designated_version WHERE g.workspace_id = ? AND g.status = 'active' AND ((a.scope_type = 'user' AND a.scope_id = ?) OR (a.scope_type = 'api_key' AND a.scope_id = ?)) ORDER BY a.scope_type, a.id`).bind(workspaceId, userId, apiKeyId).all<EffectiveGuardrailRow>()).results ?? [];
		},
		async createWithVersion(params) {
			await raw.batch([
				raw.prepare(`INSERT INTO guardrails (id, workspace_id, owner_user_id, name, description, status, designated_version, latest_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', 1, 1, ?, ?)`).bind(params.id, params.workspaceId, params.ownerUserId, params.name, params.description, params.nowIso, params.nowIso),
				raw.prepare(`INSERT INTO guardrail_versions (id, guardrail_id, version, config_json, created_by_user_id, created_at) VALUES (?, ?, 1, ?, ?, ?)`).bind(params.versionId, params.id, params.configJson, params.createdByUserId, params.nowIso),
			]);
			const row = await getById(params.id); if (!row) throw new Error('guardrail create did not return a row'); return row;
		},
		async addVersion(params) {
			const protection = params.preserveAdminManaged
				? ` AND NOT EXISTS (SELECT 1 FROM guardrail_assignments a WHERE a.guardrail_id = guardrails.id AND a.created_by_user_id IS NULL)`
				: '';
			const results = await raw.batch([
				raw.prepare(`UPDATE guardrails SET latest_version = latest_version + 1, designated_version = latest_version + 1, name = ?, description = ?, updated_at = ? WHERE id = ? AND status = 'active'${protection}`).bind(params.name, params.description, params.nowIso, params.guardrailId),
				raw.prepare(`INSERT INTO guardrail_versions (id, guardrail_id, version, config_json, created_by_user_id, created_at) SELECT ?, id, latest_version, ?, ?, ? FROM guardrails WHERE id = ? AND status = 'active'${protection}`).bind(params.versionId, params.configJson, params.createdByUserId, params.nowIso, params.guardrailId),
			]);
			if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) return null;
			const row = await getById(params.guardrailId); if (!row) throw new Error('guardrail version create did not return a row'); return row;
		},
		async updateMetadata(id, patch) {
			const protection = patch.preserveAdminManaged
				? ` AND NOT EXISTS (SELECT 1 FROM guardrail_assignments a WHERE a.guardrail_id = guardrails.id AND a.created_by_user_id IS NULL)`
				: '';
			const result = await raw.prepare(`UPDATE guardrails SET name = CASE WHEN ? = 1 THEN ? ELSE name END, description = CASE WHEN ? = 1 THEN ? ELSE description END, status = CASE WHEN ? = 1 THEN ? ELSE status END, updated_at = ? WHERE id = ?${protection}`).bind(
				patch.name === undefined ? 0 : 1, patch.name ?? '', patch.description === undefined ? 0 : 1, patch.description ?? null,
				patch.status === undefined ? 0 : 1, patch.status ?? 'active', patch.nowIso, id,
			).run(); return (result.meta.changes ?? 0) === 1;
		},
		async designateVersion(id, version, nowIso, options) {
			const protection = options?.preserveAdminManaged
				? ` AND NOT EXISTS (SELECT 1 FROM guardrail_assignments a WHERE a.guardrail_id = guardrails.id AND a.created_by_user_id IS NULL)`
				: '';
			const result = await raw.prepare(`UPDATE guardrails SET designated_version = ?, updated_at = ? WHERE id = ? AND status = 'active' AND EXISTS (SELECT 1 FROM guardrail_versions v WHERE v.guardrail_id = guardrails.id AND v.version = ?)${protection}`).bind(version, nowIso, id, version).run();
			return (result.meta.changes ?? 0) === 1;
		},
		async upsertAssignment(params) {
			const protection = params.preserveAdminManaged ? ' WHERE guardrail_assignments.created_by_user_id IS NOT NULL' : '';
			await raw.prepare(`INSERT INTO guardrail_assignments (id, workspace_id, guardrail_id, scope_type, scope_id, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, scope_type, scope_id) DO UPDATE SET guardrail_id = excluded.guardrail_id, created_by_user_id = excluded.created_by_user_id, created_at = excluded.created_at${protection}`).bind(params.id, params.workspaceId, params.guardrailId, params.scopeType, params.scopeId, params.createdByUserId, params.nowIso).run();
			const row = await raw.prepare(`SELECT a.id, a.workspace_id, a.guardrail_id, a.scope_type, a.scope_id, a.created_by_user_id, a.created_at, g.name AS guardrail_name FROM guardrail_assignments a JOIN guardrails g ON g.id = a.guardrail_id WHERE a.workspace_id = ? AND a.scope_type = ? AND a.scope_id = ?`).bind(params.workspaceId, params.scopeType, params.scopeId).first<GuardrailAssignmentRow>();
			if (!row) throw new Error('guardrail assignment did not return a row'); return row;
		},
		async deleteAssignment(workspaceId, scopeType, scopeId, createdByUserId) {
			const ownerClause = createdByUserId === undefined ? '' : ' AND created_by_user_id = ?';
			const statement = raw.prepare(`DELETE FROM guardrail_assignments WHERE workspace_id = ? AND scope_type = ? AND scope_id = ?${ownerClause}`);
			const result = await (createdByUserId === undefined ? statement.bind(workspaceId, scopeType, scopeId) : statement.bind(workspaceId, scopeType, scopeId, createdByUserId)).run(); return (result.meta.changes ?? 0) > 0;
		},
		async getSettledBudgetSpent(workspaceId, scopeType, scopeId, sinceIso) {
			const column = scopeType === 'user' ? 'user_id' : 'api_key_id';
			const row = await raw.prepare(`SELECT COALESCE(SUM(l.charged_cost), 0) AS spent FROM api_key_request_logs l WHERE l.${column} = ? AND l.created_at >= ? AND EXISTS (SELECT 1 FROM api_keys k WHERE k.id = l.api_key_id AND k.workspace_id = ?)`).bind(scopeId, sinceIso, workspaceId).first<{ spent: number | string }>();
			return Number(row?.spent ?? 0);
		},
	};
}
