import type { D1DatabaseClient } from '../../storage/database-client';
import type { RequestPresetsRepository } from '../../storage/gateway-repository-interfaces';
import type {
	RequestPresetVersionRow,
	RequestPresetWithVersionRow,
} from '../request-presets-types';

const SELECT_DESIGNATED = `
	SELECT p.id, p.workspace_id, p.owner_user_id, p.slug, p.name, p.description, p.visibility, p.status,
		p.designated_version, p.latest_version, p.created_at, p.updated_at,
		v.id AS version_id, v.system_prompt AS version_system_prompt,
		v.config_json AS version_config_json,
		v.created_by_user_id AS version_created_by_user_id,
		v.created_at AS version_created_at
	FROM request_presets p
	JOIN request_preset_versions v
		ON v.preset_id = p.id AND v.version = p.designated_version`;

export function createD1RequestPresetsRepository(db: D1DatabaseClient): RequestPresetsRepository {
	const raw = db.raw;
	const getById = async (id: string): Promise<RequestPresetWithVersionRow | null> =>
		(await raw.prepare(`${SELECT_DESIGNATED} WHERE p.id = ?`).bind(id).first<RequestPresetWithVersionRow>()) ?? null;

	return {
		async listOwnedByWorkspace(workspaceId, userId, includeArchived = false) {
			const status = includeArchived ? '' : " AND p.status = 'active'";
			const rows = await raw.prepare(`${SELECT_DESIGNATED} WHERE p.workspace_id = ? AND p.owner_user_id = ?${status} ORDER BY p.updated_at DESC, p.id`).bind(workspaceId, userId).all<RequestPresetWithVersionRow>();
			return rows.results ?? [];
		},
		async listAll(includeArchived = false) {
			const status = includeArchived ? '' : " WHERE p.status = 'active'";
			const rows = await raw.prepare(`${SELECT_DESIGNATED}${status} ORDER BY p.updated_at DESC, p.id`).all<RequestPresetWithVersionRow>();
			return rows.results ?? [];
		},
		async listVisibleByWorkspacePage(workspaceId, userId, page) {
			const visibility = `(p.owner_user_id = ? OR (p.visibility = 'public' AND p.status = 'active'))`;
			const count = await raw.prepare(`SELECT COUNT(*) AS total_count FROM request_presets p
				WHERE p.workspace_id = ? AND ${visibility}`)
				.bind(workspaceId, userId).first<{ total_count: number | string }>();
			const rows = await raw.prepare(`${SELECT_DESIGNATED} WHERE p.workspace_id = ? AND ${visibility}
				ORDER BY p.updated_at DESC, p.id ASC LIMIT ? OFFSET ?`)
				.bind(workspaceId, userId, page.limit, page.offset).all<RequestPresetWithVersionRow>();
			return { data: rows.results ?? [], totalCount: Number(count?.total_count ?? 0) };
		},
		getById,
		async getByIdInWorkspace(id, workspaceId) {
			return (await raw.prepare(`${SELECT_DESIGNATED} WHERE p.id = ? AND p.workspace_id = ?`).bind(id, workspaceId).first<RequestPresetWithVersionRow>()) ?? null;
		},
		async getBySlug(slug, workspaceId) {
			return (await raw.prepare(`${SELECT_DESIGNATED} WHERE p.workspace_id = ? AND p.slug = ?`).bind(workspaceId, slug).first<RequestPresetWithVersionRow>()) ?? null;
		},
		async getAccessibleBySlug(slug, workspaceId, userId) {
			return (await raw.prepare(`${SELECT_DESIGNATED} WHERE p.workspace_id = ? AND p.slug = ? AND p.status = 'active' AND (p.owner_user_id = ? OR p.visibility = 'public')`).bind(workspaceId, slug, userId).first<RequestPresetWithVersionRow>()) ?? null;
		},
		async getVisibleBySlug(slug, workspaceId, userId) {
			return (await raw.prepare(`${SELECT_DESIGNATED} WHERE p.workspace_id = ? AND p.slug = ?
				AND (p.owner_user_id = ? OR (p.visibility = 'public' AND p.status = 'active'))`)
				.bind(workspaceId, slug, userId).first<RequestPresetWithVersionRow>()) ?? null;
		},
		async listVersions(presetId) {
			const rows = await raw.prepare(`SELECT id, preset_id, version, system_prompt, config_json, created_by_user_id, created_at FROM request_preset_versions WHERE preset_id = ? ORDER BY version DESC`).bind(presetId).all<RequestPresetVersionRow>();
			return rows.results ?? [];
		},
		async listVersionsPage(presetId, page) {
			const count = await raw.prepare(`SELECT COUNT(*) AS total_count FROM request_preset_versions WHERE preset_id = ?`)
				.bind(presetId).first<{ total_count: number | string }>();
			const rows = await raw.prepare(`SELECT id, preset_id, version, system_prompt, config_json,
				created_by_user_id, created_at FROM request_preset_versions WHERE preset_id = ?
				ORDER BY version ASC LIMIT ? OFFSET ?`)
				.bind(presetId, page.limit, page.offset).all<RequestPresetVersionRow>();
			return { data: rows.results ?? [], totalCount: Number(count?.total_count ?? 0) };
		},
		async getVersion(presetId, version) {
			return (await raw.prepare(`SELECT id, preset_id, version, system_prompt, config_json,
				created_by_user_id, created_at FROM request_preset_versions
				WHERE preset_id = ? AND version = ?`).bind(presetId, version)
				.first<RequestPresetVersionRow>()) ?? null;
		},
		async createWithVersion(params) {
			await raw.batch([
				raw.prepare(`INSERT INTO request_presets (id, workspace_id, owner_user_id, slug, name, description, visibility, status, designated_version, latest_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1, 1, ?, ?)`).bind(params.id, params.workspaceId, params.ownerUserId, params.slug, params.name, params.description, params.visibility, params.nowIso, params.nowIso),
				raw.prepare(`INSERT INTO request_preset_versions (id, preset_id, version, system_prompt, config_json, created_by_user_id, created_at) VALUES (?, ?, 1, ?, ?, ?, ?)`).bind(params.versionId, params.id, params.systemPrompt, params.configJson, params.createdByUserId, params.nowIso),
			]);
			const row = await getById(params.id);
			if (!row) throw new Error('request preset create did not return a row');
			return row;
		},
		async addVersion(params) {
			const results = await raw.batch([
				raw.prepare(`UPDATE request_presets SET latest_version = latest_version + 1, designated_version = latest_version + 1, updated_at = ? WHERE id = ? AND status = 'active'`).bind(params.nowIso, params.presetId),
				raw.prepare(`INSERT INTO request_preset_versions (id, preset_id, version, system_prompt, config_json, created_by_user_id, created_at) SELECT ?, id, latest_version, ?, ?, ?, ? FROM request_presets WHERE id = ? AND status = 'active'`).bind(params.versionId, params.systemPrompt, params.configJson, params.createdByUserId, params.nowIso, params.presetId),
			]);
			if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) {
				throw new Error('request preset not found or archived');
			}
			const row = await getById(params.presetId);
			if (!row) throw new Error('request preset version create did not return a row');
			return row;
		},
		async updateMetadata(id, patch) {
			const result = await raw.prepare(`UPDATE request_presets SET name = CASE WHEN ? = 1 THEN ? ELSE name END, description = CASE WHEN ? = 1 THEN ? ELSE description END, visibility = CASE WHEN ? = 1 THEN ? ELSE visibility END, status = CASE WHEN ? = 1 THEN ? ELSE status END, updated_at = ? WHERE id = ?`).bind(
				patch.name === undefined ? 0 : 1, patch.name ?? '',
				patch.description === undefined ? 0 : 1, patch.description ?? null,
				patch.visibility === undefined ? 0 : 1, patch.visibility ?? 'private',
				patch.status === undefined ? 0 : 1, patch.status ?? 'active',
				patch.nowIso, id,
			).run();
			return (result.meta.changes ?? 0) === 1;
		},
		async designateVersion(id, version, nowIso) {
			const result = await raw.prepare(`UPDATE request_presets SET designated_version = ?, updated_at = ? WHERE id = ? AND status = 'active' AND EXISTS (SELECT 1 FROM request_preset_versions v WHERE v.preset_id = request_presets.id AND v.version = ?)`).bind(version, nowIso, id, version).run();
			return (result.meta.changes ?? 0) === 1;
		},
	};
}
