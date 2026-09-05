import type { GuardrailAssignmentRow, GuardrailVersionRow, GuardrailWithVersionRow } from '@octafuse/core';

function parseConfig(value: string): Record<string, unknown> | null {
	try { return JSON.parse(value) as Record<string, unknown>; } catch { return null; }
}

export function guardrailResponse(row: GuardrailWithVersionRow) {
	return {
		id: row.id, workspaceId: row.workspace_id, ownerUserId: row.owner_user_id, name: row.name, description: row.description,
		status: row.status, isWorkspaceDefault: Boolean(row.is_workspace_default),
		isAccountDefault: Boolean(row.is_account_default), accountScopeKey: row.account_scope_key ?? null,
		designatedVersion: row.designated_version, latestVersion: row.latest_version,
		config: parseConfig(row.version_config_json), createdAt: row.created_at, updatedAt: row.updated_at,
		versionCreatedAt: row.version_created_at,
	};
}

export function guardrailVersionResponse(row: GuardrailVersionRow) {
	return { id: row.id, version: row.version, config: parseConfig(row.config_json), createdByUserId: row.created_by_user_id, createdAt: row.created_at };
}

export function guardrailAssignmentResponse(row: GuardrailAssignmentRow) {
	return { id: row.id, workspaceId: row.workspace_id, guardrailId: row.guardrail_id, guardrailName: row.guardrail_name ?? null, scopeType: row.scope_type, scopeId: row.scope_id, createdByUserId: row.created_by_user_id, createdAt: row.created_at };
}
