import type { RequestPresetVersionRow, RequestPresetWithVersionRow } from '@octafuse/core';

function parseConfig(configJson: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(configJson) as unknown;
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: null;
	} catch {
		return null;
	}
}

export function requestPresetResponse(row: RequestPresetWithVersionRow) {
	return {
		id: row.id,
		workspaceId: row.workspace_id,
		ownerUserId: row.owner_user_id,
		slug: row.slug,
		name: row.name,
		description: row.description,
		visibility: row.visibility,
		status: row.status,
		designatedVersion: row.designated_version,
		latestVersion: row.latest_version,
		systemPrompt: row.version_system_prompt,
		config: parseConfig(row.version_config_json),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		versionCreatedAt: row.version_created_at,
	};
}

export function requestPresetVersionResponse(row: RequestPresetVersionRow) {
	return {
		id: row.id,
		version: row.version,
		systemPrompt: row.system_prompt,
		config: parseConfig(row.config_json),
		createdByUserId: row.created_by_user_id,
		createdAt: row.created_at,
	};
}
