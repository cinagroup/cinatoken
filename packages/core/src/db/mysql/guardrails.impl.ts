import type { MySqlDatabaseClient } from '../../storage/database-client';
import type { GuardrailsRepository } from '../../storage/gateway-repository-interfaces';
import type { EffectiveGuardrailRow, GuardrailAssignmentRow, GuardrailVersionRow, GuardrailWithVersionRow } from '../guardrails-types';
import { asMySqlPool } from './mysql2-compat';

const SELECT_DESIGNATED = `SELECT g.id, g.workspace_id, g.owner_user_id, g.name, g.description, g.status, g.designated_version, g.latest_version, g.created_at, g.updated_at, v.id AS version_id, v.config_json AS version_config_json, v.created_by_user_id AS version_created_by_user_id, v.created_at AS version_created_at FROM guardrails g JOIN guardrail_versions v ON v.guardrail_id = g.id AND v.version = g.designated_version`;

export function createMySqlGuardrailsRepository(db: MySqlDatabaseClient): GuardrailsRepository {
	const pool = asMySqlPool(db.raw);
	const query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => (await pool.query(sql, params))[0] as T[];
	const getById = async (id: string) => (await query<GuardrailWithVersionRow>(`${SELECT_DESIGNATED} WHERE g.id = ?`, [id]))[0] ?? null;
	return {
		async listOwnedByWorkspace(workspaceId, userId, includeArchived = false) { return query(`${SELECT_DESIGNATED} WHERE g.workspace_id = ? AND g.owner_user_id = ?${includeArchived ? '' : " AND g.status = 'active'"} ORDER BY g.updated_at DESC, g.id`, [workspaceId, userId]); },
		async listAll(includeArchived = false) { return query(`${SELECT_DESIGNATED}${includeArchived ? '' : " WHERE g.status = 'active'"} ORDER BY g.updated_at DESC, g.id`); },
		getById,
		async getByIdInWorkspace(id, workspaceId) { return (await query<GuardrailWithVersionRow>(`${SELECT_DESIGNATED} WHERE g.id = ? AND g.workspace_id = ?`, [id, workspaceId]))[0] ?? null; },
		async listVersions(guardrailId) { return query<GuardrailVersionRow>(`SELECT id, guardrail_id, version, config_json, created_by_user_id, created_at FROM guardrail_versions WHERE guardrail_id = ? ORDER BY version DESC`, [guardrailId]); },
		async listAssignments(guardrailId) { return query<GuardrailAssignmentRow>(`SELECT a.id, a.workspace_id, a.guardrail_id, a.scope_type, a.scope_id, a.created_by_user_id, a.created_at, g.name AS guardrail_name FROM guardrail_assignments a JOIN guardrails g ON g.id = a.guardrail_id WHERE a.guardrail_id = ? ORDER BY a.scope_type, a.scope_id`, [guardrailId]); },
		async getEffectiveForRequest(workspaceId, userId, apiKeyId) { return query<EffectiveGuardrailRow>(`SELECT g.id, g.workspace_id, g.owner_user_id, g.name, g.description, g.status, g.designated_version, g.latest_version, g.created_at, g.updated_at, v.id AS version_id, v.config_json AS version_config_json, v.created_by_user_id AS version_created_by_user_id, v.created_at AS version_created_at, a.id AS assignment_id, a.scope_type AS assignment_scope_type, a.scope_id AS assignment_scope_id FROM guardrail_assignments a JOIN guardrails g ON g.id = a.guardrail_id AND g.workspace_id = a.workspace_id JOIN guardrail_versions v ON v.guardrail_id = g.id AND v.version = g.designated_version WHERE g.workspace_id = ? AND g.status = 'active' AND ((a.scope_type = 'user' AND a.scope_id = ?) OR (a.scope_type = 'api_key' AND a.scope_id = ?)) ORDER BY a.scope_type, a.id`, [workspaceId, userId, apiKeyId]); },
		async createWithVersion(params) {
			const connection = await pool.getConnection(); try { await connection.beginTransaction(); await connection.execute(`INSERT INTO guardrails (id, workspace_id, workspace_key, owner_user_id, name, description, status, designated_version, latest_version, created_at, updated_at) VALUES (?, ?, SHA2(?, 256), ?, ?, ?, 'active', 1, 1, ?, ?)`, [params.id, params.workspaceId, params.workspaceId, params.ownerUserId, params.name, params.description, params.nowIso, params.nowIso]); await connection.execute(`INSERT INTO guardrail_versions (id, guardrail_id, version, config_json, created_by_user_id, created_at) VALUES (?, ?, 1, ?, ?, ?)`, [params.versionId, params.id, params.configJson, params.createdByUserId, params.nowIso]); await connection.commit(); } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
			const row = await getById(params.id); if (!row) throw new Error('guardrail create did not return a row'); return row;
		},
		async addVersion(params) {
			const protection = params.preserveAdminManaged
				? ` AND NOT EXISTS (SELECT 1 FROM guardrail_assignments a WHERE a.guardrail_id = guardrails.id AND a.created_by_user_id IS NULL)`
				: '';
			const connection = await pool.getConnection();
			let versionCreated = false;
			try {
				await connection.beginTransaction();
				const [result] = await connection.execute<import('mysql2/promise').ResultSetHeader>(
					`UPDATE guardrails SET latest_version = latest_version + 1, designated_version = latest_version + 1, name = ?, description = ?, updated_at = ? WHERE id = ? AND status = 'active'${protection}`,
					[params.name, params.description, params.nowIso, params.guardrailId],
				);
				if (result.affectedRows !== 1) {
					await connection.rollback();
					return null;
				}
				const [rows] = await connection.query<Array<{ latest_version: number }>>(`SELECT latest_version FROM guardrails WHERE id = ? FOR UPDATE`, [params.guardrailId]);
				const version = rows[0]?.latest_version;
				if (!version) throw new Error('guardrail version allocation failed');
				await connection.execute(`INSERT INTO guardrail_versions (id, guardrail_id, version, config_json, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [params.versionId, params.guardrailId, version, params.configJson, params.createdByUserId, params.nowIso]);
				await connection.commit();
				versionCreated = true;
			} catch (error) {
				await connection.rollback();
				throw error;
			} finally {
				connection.release();
			}
			if (!versionCreated) return null;
			const row = await getById(params.guardrailId); if (!row) throw new Error('guardrail version create did not return a row'); return row;
		},
		async updateMetadata(id, patch) {
			const sets = ['updated_at = ?']; const values: unknown[] = [patch.nowIso]; for (const [column, value] of [['name', patch.name], ['description', patch.description], ['status', patch.status]] as const) { if (value !== undefined) { sets.push(`${column} = ?`); values.push(value); } } values.push(id);
			const protection = patch.preserveAdminManaged
				? ` AND NOT EXISTS (SELECT 1 FROM guardrail_assignments a WHERE a.guardrail_id = guardrails.id AND a.created_by_user_id IS NULL)`
				: '';
			const [result] = await pool.execute<import('mysql2/promise').ResultSetHeader>(`UPDATE guardrails SET ${sets.join(', ')} WHERE id = ?${protection}`, values); return result.affectedRows === 1;
		},
		async designateVersion(id, version, nowIso, options) {
			const protection = options?.preserveAdminManaged
				? ` AND NOT EXISTS (SELECT 1 FROM guardrail_assignments a WHERE a.guardrail_id = g.id AND a.created_by_user_id IS NULL)`
				: '';
			const [result] = await pool.execute<import('mysql2/promise').ResultSetHeader>(`UPDATE guardrails g SET g.designated_version = ?, g.updated_at = ? WHERE g.id = ? AND g.status = 'active' AND EXISTS (SELECT 1 FROM guardrail_versions v WHERE v.guardrail_id = g.id AND v.version = ?)${protection}`, [version, nowIso, id, version]); return result.affectedRows === 1;
		},
		async upsertAssignment(params) {
			const update = params.preserveAdminManaged
				? `guardrail_id = IF(created_by_user_id IS NULL, guardrail_id, VALUES(guardrail_id)), created_at = IF(created_by_user_id IS NULL, created_at, VALUES(created_at)), created_by_user_id = IF(created_by_user_id IS NULL, created_by_user_id, VALUES(created_by_user_id))`
				: `guardrail_id = VALUES(guardrail_id), created_by_user_id = VALUES(created_by_user_id), created_at = VALUES(created_at)`;
			await pool.execute(`INSERT INTO guardrail_assignments (id, workspace_id, workspace_key, guardrail_id, scope_type, scope_id, created_by_user_id, created_at) VALUES (?, ?, SHA2(?, 256), ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE ${update}`, [params.id, params.workspaceId, params.workspaceId, params.guardrailId, params.scopeType, params.scopeId, params.createdByUserId, params.nowIso]); return (await query<GuardrailAssignmentRow>(`SELECT a.id, a.workspace_id, a.guardrail_id, a.scope_type, a.scope_id, a.created_by_user_id, a.created_at, g.name AS guardrail_name FROM guardrail_assignments a JOIN guardrails g ON g.id = a.guardrail_id WHERE a.workspace_id = ? AND a.scope_type = ? AND a.scope_id = ?`, [params.workspaceId, params.scopeType, params.scopeId]))[0]!;
		},
		async deleteAssignment(workspaceId, scopeType, scopeId, createdByUserId) { const ownerClause = createdByUserId === undefined ? '' : ' AND created_by_user_id = ?'; const values = createdByUserId === undefined ? [workspaceId, scopeType, scopeId] : [workspaceId, scopeType, scopeId, createdByUserId]; const [result] = await pool.execute<import('mysql2/promise').ResultSetHeader>(`DELETE FROM guardrail_assignments WHERE workspace_id = ? AND scope_type = ? AND scope_id = ?${ownerClause}`, values); return result.affectedRows > 0; },
		async getSettledBudgetSpent(workspaceId, scopeType, scopeId, sinceIso) { const column = scopeType === 'user' ? 'user_id' : 'api_key_id'; const row = (await query<{ spent: string | number }>(`SELECT COALESCE(SUM(l.charged_cost), 0) AS spent FROM api_key_request_logs l WHERE l.${column} = ? AND l.created_at >= ? AND EXISTS (SELECT 1 FROM api_keys k WHERE k.id = l.api_key_id AND k.workspace_id = ?)`, [scopeId, sinceIso, workspaceId]))[0]; return Number(row?.spent ?? 0); },
	};
}
