import { and, desc, eq, or, sql } from 'drizzle-orm';
import type { PostgresDatabaseClient } from '../../storage/database-client';
import type { RequestPresetsRepository } from '../../storage/gateway-repository-interfaces';
import {
	requestPresetsTable,
	requestPresetVersionsTable,
} from '../../storage/drizzle/schema.pg';
import type { RequestPresetWithVersionRow } from '../request-presets-types';

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

export function createPostgresRequestPresetsRepository(db: PostgresDatabaseClient): RequestPresetsRepository {
	const drizzle = db.drizzle;
	const base = () => drizzle.select(designatedSelection)
		.from(requestPresetsTable)
		.innerJoin(requestPresetVersionsTable, and(
			eq(requestPresetVersionsTable.presetId, requestPresetsTable.id),
			eq(requestPresetVersionsTable.version, requestPresetsTable.designatedVersion),
		));
	const getById = async (id: string): Promise<RequestPresetWithVersionRow | null> =>
		(await base().where(eq(requestPresetsTable.id, id)).limit(1))[0] as RequestPresetWithVersionRow | undefined ?? null;

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
			return (await base().where(and(eq(requestPresetsTable.id, id), eq(requestPresetsTable.workspaceId, workspaceId))).limit(1))[0] as RequestPresetWithVersionRow | undefined ?? null;
		},
		async getBySlug(slug, workspaceId) {
			return (await base().where(and(eq(requestPresetsTable.workspaceId, workspaceId), eq(requestPresetsTable.slug, slug))).limit(1))[0] as RequestPresetWithVersionRow | undefined ?? null;
		},
		async getAccessibleBySlug(slug, workspaceId, userId) {
			return (await base().where(and(
				eq(requestPresetsTable.workspaceId, workspaceId),
				eq(requestPresetsTable.slug, slug),
				eq(requestPresetsTable.status, 'active'),
				or(eq(requestPresetsTable.ownerUserId, userId), eq(requestPresetsTable.visibility, 'public')),
			)).limit(1))[0] as RequestPresetWithVersionRow | undefined ?? null;
		},
		async listVersions(presetId) {
			const rows = await drizzle.select({
				id: requestPresetVersionsTable.id,
				preset_id: requestPresetVersionsTable.presetId,
				version: requestPresetVersionsTable.version,
				system_prompt: requestPresetVersionsTable.systemPrompt,
				config_json: requestPresetVersionsTable.configJson,
				created_by_user_id: requestPresetVersionsTable.createdByUserId,
				created_at: requestPresetVersionsTable.createdAt,
			}).from(requestPresetVersionsTable).where(eq(requestPresetVersionsTable.presetId, presetId)).orderBy(desc(requestPresetVersionsTable.version));
			return rows;
		},
		async createWithVersion(params) {
			await drizzle.transaction(async (tx) => {
				await tx.insert(requestPresetsTable).values({
					id: params.id, workspaceId: params.workspaceId, ownerUserId: params.ownerUserId, slug: params.slug,
					name: params.name, description: params.description, visibility: params.visibility,
					status: 'active', designatedVersion: 1, latestVersion: 1,
					createdAt: params.nowIso, updatedAt: params.nowIso,
				});
				await tx.insert(requestPresetVersionsTable).values({
					id: params.versionId, presetId: params.id, version: 1,
					systemPrompt: params.systemPrompt, configJson: params.configJson,
					createdByUserId: params.createdByUserId, createdAt: params.nowIso,
				});
			});
			const row = await getById(params.id);
			if (!row) throw new Error('request preset create did not return a row');
			return row;
		},
		async addVersion(params) {
			await drizzle.transaction(async (tx) => {
				const updated = await tx.update(requestPresetsTable).set({
					latestVersion: sql`${requestPresetsTable.latestVersion} + 1`,
					designatedVersion: sql`${requestPresetsTable.latestVersion} + 1`,
					updatedAt: params.nowIso,
				}).where(and(eq(requestPresetsTable.id, params.presetId), eq(requestPresetsTable.status, 'active')))
					.returning({ version: requestPresetsTable.latestVersion });
				const version = updated[0]?.version;
				if (!version) throw new Error('request preset not found or archived');
				await tx.insert(requestPresetVersionsTable).values({
					id: params.versionId, presetId: params.presetId, version,
					systemPrompt: params.systemPrompt, configJson: params.configJson,
					createdByUserId: params.createdByUserId, createdAt: params.nowIso,
				});
			});
			const row = await getById(params.presetId);
			if (!row) throw new Error('request preset version create did not return a row');
			return row;
		},
		async updateMetadata(id, patch) {
			const values: Record<string, unknown> = { updatedAt: patch.nowIso };
			if (patch.name !== undefined) values.name = patch.name;
			if (patch.description !== undefined) values.description = patch.description;
			if (patch.visibility !== undefined) values.visibility = patch.visibility;
			if (patch.status !== undefined) values.status = patch.status;
			const rows = await drizzle.update(requestPresetsTable).set(values).where(eq(requestPresetsTable.id, id)).returning({ id: requestPresetsTable.id });
			return rows.length === 1;
		},
		async designateVersion(id, version, nowIso) {
			const rows = await drizzle.update(requestPresetsTable).set({ designatedVersion: version, updatedAt: nowIso }).where(and(
				eq(requestPresetsTable.id, id),
				eq(requestPresetsTable.status, 'active'),
				sql`EXISTS (SELECT 1 FROM ${requestPresetVersionsTable} v WHERE v.preset_id = ${requestPresetsTable.id} AND v.version = ${version})`,
			)).returning({ id: requestPresetsTable.id });
			return rows.length === 1;
		},
	};
}
