import type {
	GuardrailAssignmentRow,
	GuardrailVersionRow,
	GuardrailWithVersionRow,
	WorkspaceAccessProjection,
} from "@octafuse/core";
import { normalizeBillingCurrencyCode } from "@octafuse/core/lib/billing-currency";

function parseConfig(value: string): Record<string, unknown> | null {
	try {
		return JSON.parse(value) as Record<string, unknown>;
	} catch {
		return null;
	}
}

export function guardrailResponse(row: GuardrailWithVersionRow) {
	return {
		id: row.id,
		workspaceId: row.workspace_id,
		ownerUserId: row.owner_user_id,
		name: row.name,
		description: row.description,
		status: row.status,
		isWorkspaceDefault: Boolean(row.is_workspace_default),
		isAccountDefault: Boolean(row.is_account_default),
		accountScopeKey: row.account_scope_key ?? null,
		designatedVersion: row.designated_version,
		latestVersion: row.latest_version,
		config: parseConfig(row.version_config_json),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		versionCreatedAt: row.version_created_at,
	};
}

export function guardrailVersionResponse(row: GuardrailVersionRow) {
	return {
		id: row.id,
		version: row.version,
		config: parseConfig(row.config_json),
		createdByUserId: row.created_by_user_id,
		createdAt: row.created_at,
	};
}

export function guardrailAssignmentResponse(row: GuardrailAssignmentRow) {
	return {
		id: row.id,
		workspaceId: row.workspace_id,
		guardrailId: row.guardrail_id,
		guardrailName: row.guardrail_name ?? null,
		scopeType: row.scope_type,
		scopeId: row.scope_id,
		createdByUserId: row.created_by_user_id,
		createdAt: row.created_at,
	};
}

/** Admin list/write projection. Version configuration is deliberately never parsed or copied. */
export function adminGuardrailSummaryResponse(row: GuardrailWithVersionRow) {
	return {
		id: row.id,
		workspaceId: row.workspace_id,
		ownerUserId: row.owner_user_id,
		name: row.name,
		description: row.description,
		status: row.status,
		isWorkspaceDefault: Boolean(row.is_workspace_default),
		isAccountDefault: Boolean(row.is_account_default),
		accountScopeKey: row.account_scope_key ?? null,
		designatedVersion: row.designated_version,
		latestVersion: row.latest_version,
	};
}

/** Admin history needs only identity, version and creation time for designation. */
export function adminGuardrailVersionSummaryResponse(row: GuardrailVersionRow) {
	return { id: row.id, version: row.version, createdAt: row.created_at };
}

/** Admin preview scope is derived only after the requested user and Workspace are resolved. */
export function adminGuardrailPreviewMetadata(
	workspace: Pick<
		WorkspaceAccessProjection,
		"id" | "scopeType" | "personalOwnerUserId" | "organizationId"
	>,
	userId: string,
	apiKeyId: string | null,
	rawBudgetCurrency: string | null
) {
	const ownerId =
		workspace.scopeType === "personal"
			? workspace.personalOwnerUserId
			: workspace.organizationId;
	if (!ownerId) throw new Error("Resolved Workspace has no account owner");
	return {
		workspaceId: workspace.id,
		userId,
		accountScopeKey: `${workspace.scopeType}:${ownerId}`,
		budgetCurrency: normalizeBillingCurrencyCode(rawBudgetCurrency),
		pricingCurrency: "USD" as const,
		apiKeyId,
	};
}

export function adminGuardrailPreviewSuccess<T extends object>(
	value: T,
	metadata: ReturnType<typeof adminGuardrailPreviewMetadata>
) {
	return { success: true as const, data: { ...value, ...metadata } };
}

export function adminGuardrailPreviewConflict(
	message: string,
	trace: unknown,
	metadata: ReturnType<typeof adminGuardrailPreviewMetadata>
) {
	return {
		success: false as const,
		code: "guardrail_effective_conflict" as const,
		message,
		...metadata,
		trace,
	};
}
