import type {
	RequestPresetVersionRow,
	RequestPresetWithVersionRow,
} from "@octafuse/core";

export type AdminPresetSummary = {
	id: string;
	workspaceId: string;
	ownerUserId: string;
	slug: string;
	name: string;
	description: string | null;
	visibility: "private" | "public";
	status: "active" | "archived";
	designatedVersion: number;
	latestVersion: number;
};

export type AdminPresetVersionSummary = {
	id: string;
	version: number;
	createdAt: string;
	model: string | null;
};

export function adminPresetSummary(
	row: RequestPresetWithVersionRow
): AdminPresetSummary {
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
	};
}

function safeModel(configJson: string): string | null {
	// This is a display-only projection. Never forward arbitrary configuration JSON.
	if (configJson.length > 131_072) return null;
	try {
		const parsed: unknown = JSON.parse(configJson);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			return null;
		const model = (parsed as Record<string, unknown>).model;
		if (
			typeof model !== "string" ||
			model.length === 0 ||
			model !== model.trim()
		)
			return null;
		if ([...model].length > 256 || /[\u0000-\u001f\u007f]/u.test(model))
			return null;
		return model;
	} catch {
		return null;
	}
}

export function adminPresetVersionSummary(
	row: RequestPresetVersionRow
): AdminPresetVersionSummary {
	return {
		id: row.id,
		version: row.version,
		createdAt: row.created_at,
		model: safeModel(row.config_json),
	};
}
