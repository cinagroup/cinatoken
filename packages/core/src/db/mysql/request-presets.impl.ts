import { and, desc, eq, or } from 'drizzle-orm';
import type { MySqlDatabaseClient } from '../../storage/database-client';
import type { RequestPresetsRepository } from '../../storage/gateway-repository-interfaces';
import {
	requestPresetsTable,
	requestPresetVersionsTable,
} from '../../storage/drizzle/schema.mysql';
import type { RequestPresetWithVersionRow } from '../request-presets-types';
import { asMySqlPool } from './mysql2-compat';

const designatedSelection = {
	id: requestPresetsTable.id,
	workspace_id: requestPresetsTable.workspaceId,
	owner_user_id: requestPresetsTable.ownerUserId,
	slug: requestPresetsTable.slug,
	name: requestPresetsTable.name,
	description: requestPresetsTable.description,
	visibility: requestPresetsTable.visibility,
	status: requestPresetsTable.status,
	designated_version: requestPresetsTable.designatedVersion,
	latest_version: requestPresetsTable.latestVersion,
	created_at: requestPresetsTable.createdAt,
	updated_at: requestPresetsTable.updatedAt,
	version_id: requestPresetVersionsTable.id,
	version_system_prompt: requestPresetVersionsTable.systemPrompt,
	version_config_json: requestPresetVersionsTable.configJson,
	version_created_by_user_id: requestPresetVersionsTable.createdByUserId,
	version_created_at: requestPresetVersionsTable.createdAt,
};

export function createMySqlRequestPresetsRepository(db: MySqlDatabaseClient): RequestPresetsRepository {
	const drizzle = db.drizzle;
	const pool = asMySqlPool(db.raw);
	const base = () => drizzle.select(designatedSelection)
		.from(requestPresetsTable)
		.innerJoin(requestPresetVersionsTable, and(
			eq(requestPresetVersionsTable.presetId, requestPresetsTable.id),
			eq(requestPresetVersionsTable.version, requestPresetsTable.designatedVersion),
		));
	const getById = async (id: string): Promise<RequestPresetWithVersionRow | null> =>
		((await base().where(eq(requestPresetsTable.id, id)).limit(1))[0] as RequestPresetWithVersionRow | undefined) ?? null;

	return {
		async listOwnedByWorkspace(workspaceId, userId, includeArchived = false) {
			const condition = includeArchived
				? and(eq(requestPresetsTable.workspaceId, workspaceId), eq(requestPresetsTable.ownerUserId, userId))
				: and(eq(requestPresetsTable.workspaceId, workspaceId), eq(requestPresetsTable.ownerUserId, userId), eq(requestPresetsTable.status, 'active'));
			return await base().where(condition).orderBy(desc(requestPresetsTable.updatedAt), requestPresetsTable.id) as RequestPresetWithVersionRow[];
		},
		async listAll(includeArchived = false) {
			const query = includeArchived ? base() : base().where(eq(requestPresetsTable.status, 'active'));
			return await query.orderBy(desc(requestPresetsTable.updatedAt), requestPresetsTable.id) as RequestPresetWithVersionRow[];
		},
		getById,
		async getByIdInWorkspace(id, workspaceId) {
			return ((await base().where(and(eq(requestPresetsTable.id, id), eq(requestPresetsTable.workspaceId, workspaceId))).limit(1))[0] as RequestPresetWithVersionRow | undefined) ?? null;
		},
		async getBySlug(slug, workspaceId) {
			return ((await base().where(and(eq(requestPresetsTable.workspaceId, workspaceId), eq(requestPresetsTable.slug, slug))).limit(1))[0] as RequestPresetWithVersionRow | undefined) ?? null;
		},
		async getAccessibleBySlug(slug, workspaceId, userId) {
			return ((await base().where(and(
				eq(requestPresetsTable.workspaceId, workspaceId),
				eq(requestPresetsTable.slug, slug),
				eq(requestPresetsTable.status, 'active'),
				or(eq(requestPresetsTable.ownerUserId, userId), eq(requestPresetsTable.visibility, 'public')),
			)).limit(1))[0] as RequestPresetWithVersionRow | undefined) ?? null;
		},
		async listVersions(presetId) {
			return drizzle.select({
				id: requestPresetVersionsTable.id,
				preset_id: requestPresetVersionsTable.presetId,
				version: requestPresetVersionsTable.version,
				system_prompt: requestPresetVersionsTable.systemPrompt,
				config_json: requestPresetVersionsTable.configJson,
				created_by_user_id: requestPresetVersionsTable.createdByUserId,
				created_at: requestPresetVersionsTable.createdAt,
			}).from(requestPresetVersionsTable).where(eq(requestPresetVersionsTable.presetId, presetId)).orderBy(desc(requestPresetVersionsTable.version));
		},
		async createWithVersion(params) {
			const connection = await pool.getConnection();
			try {
				await connection.beginTransaction();
				await connection.execute(`INSERT INTO request_presets (id, workspace_id, workspace_key, owner_user_id, slug, name, description, visibility, status, designated_version, latest_version, created_at, updated_at) VALUES (?, ?, SHA2(?, 256), ?, ?, ?, ?, ?, 'active', 1, 1, ?, ?)`, [params.id, params.workspaceId, params.workspaceId, params.ownerUserId, params.slug, params.name, params.description, params.visibility, params.nowIso, params.nowIso]);
				await connection.execute(`INSERT INTO request_preset_versions (id, preset_id, version, system_prompt, config_json, created_by_user_id, created_at) VALUES (?, ?, 1, ?, ?, ?, ?)`, [params.versionId, params.id, params.systemPrompt, params.configJson, params.createdByUserId, params.nowIso]);
				await connection.commit();
			} catch (error) {
				await connection.rollback();
				throw error;
			} finally {
				connection.release();
			}
			const row = await getById(params.id);
			if (!row) throw new Error('request preset create did not return a row');
			return row;
		},
		async addVersion(params) {
			const connection = await pool.getConnection();
			try {
				await connection.beginTransaction();
				const [result] = await connection.execute<import('mysql2/promise').ResultSetHeader>(`UPDATE request_presets SET latest_version = latest_version + 1, designated_version = latest_version + 1, updated_at = ? WHERE id = ? AND status = 'active'`, [params.nowIso, params.presetId]);
				if (result.affectedRows !== 1) throw new Error('request preset not found or archived');
				const [rows] = await connection.query<Array<{ latest_version: number }>>(`SELECT latest_version FROM request_presets WHERE id = ? FOR UPDATE`, [params.presetId]);
				const version = rows[0]?.latest_version;
				if (!version) throw new Error('request preset version allocation failed');
				await connection.execute(`INSERT INTO request_preset_versions (id, preset_id, version, system_prompt, config_json, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [params.versionId, params.presetId, version, params.systemPrompt, params.configJson, params.createdByUserId, params.nowIso]);
				await connection.commit();
			} catch (error) {
				await connection.rollback();
				throw error;
			} finally {
				connection.release();
			}
			const row = await getById(params.presetId);
			if (!row) throw new Error('request preset version create did not return a row');
			return row;
		},
		async updateMetadata(id, patch) {
			const sets: string[] = ['updated_at = ?'];
			const values: unknown[] = [patch.nowIso];
			for (const [column, value] of [
				['name', patch.name], ['description', patch.description],
				['visibility', patch.visibility], ['status', patch.status],
			] as const) {
				if (value !== undefined) { sets.push(`${column} = ?`); values.push(value); }
			}
			values.push(id);
			const [result] = await pool.execute<import('mysql2/promise').ResultSetHeader>(`UPDATE request_presets SET ${sets.join(', ')} WHERE id = ?`, values);
			return result.affectedRows === 1;
		},
		async designateVersion(id, version, nowIso) {
			const [result] = await pool.execute<import('mysql2/promise').ResultSetHeader>(`UPDATE request_presets p SET p.designated_version = ?, p.updated_at = ? WHERE p.id = ? AND p.status = 'active' AND EXISTS (SELECT 1 FROM request_preset_versions v WHERE v.preset_id = p.id AND v.version = ?)`, [version, nowIso, id, version]);
			return result.affectedRows === 1;
		},
	};
}
