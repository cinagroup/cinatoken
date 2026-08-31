import { Hono, type Context } from "hono";
import {
	createManagementApiKey,
	type ManagementApiKeyAccount,
	type ManagementApiKeyRow,
} from "@octafuse/core";
import type { UserEnv } from "@/lib/user-env";
import { hasAuthoritativeOrganizationAdminRole } from "@/lib/cinaauth/organization-admin-roles";

export const userManagementKeysRoutes = new Hono<UserEnv>();

function resolveAccount(c: Context<UserEnv>): ManagementApiKeyAccount {
	const principal = c.get("principal");
	const workspace = c.get("workspaceContext").currentWorkspace;
	if (workspace.scopeType === "personal") {
		if (
			workspace.personalOwnerUserId !== principal.userId ||
			workspace.role !== "owner"
		) {
			throw new Error("personal account ownership is invalid");
		}
		return {
			accountType: "personal",
			personalOwnerUserId: principal.userId,
			organizationId: null,
		};
	}
	if (
		!workspace.organizationId
		|| !hasAuthoritativeOrganizationAdminRole(
			workspace,
			c.env?.CINAAUTH_ORGANIZATION_ADMIN_ROLES,
		)
	) {
		throw new Error("organization administrator access is required");
	}
	return {
		accountType: "organization",
		personalOwnerUserId: null,
		organizationId: workspace.organizationId,
	};
}

function publicRow(row: ManagementApiKeyRow) {
	return {
		id: row.id,
		label: row.key_preview,
		name: row.name,
		status: row.status,
		account_type: row.account_type,
		personal_owner_user_id: row.personal_owner_user_id,
		organization_id: row.organization_id,
		expires_at: row.expires_at,
		last_used_at: row.last_used_at,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

userManagementKeysRoutes.get("/", async (c) => {
	c.header("Cache-Control", "private, no-store");
	let account: ManagementApiKeyAccount;
	try {
		account = resolveAccount(c);
	} catch (error) {
		return c.json(
			{
				success: false,
				message:
					error instanceof Error ? error.message : "Management access denied",
			},
			403
		);
	}
	const includeRevoked = c.req.query("include_revoked") === "true";
	const rows = await c
		.get("repositories")
		.managementApiKeys.listByAccount(account, { includeRevoked });
	return c.json({ success: true, data: rows.map(publicRow) });
});

userManagementKeysRoutes.post("/", async (c) => {
	c.header("Cache-Control", "private, no-store");
	let account: ManagementApiKeyAccount;
	try {
		account = resolveAccount(c);
	} catch (error) {
		return c.json(
			{
				success: false,
				message:
					error instanceof Error ? error.message : "Management access denied",
			},
			403
		);
	}
	let body: { name?: unknown; expires_at?: unknown };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ success: false, message: "Invalid JSON body" }, 400);
	}
	if (typeof body.name !== "string") {
		return c.json({ success: false, message: "name is required" }, 400);
	}
	if (
		body.expires_at !== undefined &&
		body.expires_at !== null &&
		typeof body.expires_at !== "string"
	) {
		return c.json({ success: false, message: "expires_at is invalid" }, 400);
	}
	try {
		const principal = c.get("principal");
		const created = await createManagementApiKey(c.get("repositories"), {
			...account,
			name: body.name,
			expiresAt: body.expires_at as string | null | undefined,
			createdByUserId: principal.userId,
		});
		return c.json(
			{
				success: true,
				data: publicRow(created.data),
				key: created.key,
			},
			201
		);
	} catch (error) {
		return c.json(
			{
				success: false,
				message:
					error instanceof Error
						? error.message
						: "Management key creation failed",
			},
			400
		);
	}
});

userManagementKeysRoutes.delete("/:id", async (c) => {
	c.header("Cache-Control", "private, no-store");
	let account: ManagementApiKeyAccount;
	try {
		account = resolveAccount(c);
	} catch (error) {
		return c.json(
			{
				success: false,
				message:
					error instanceof Error ? error.message : "Management access denied",
			},
			403
		);
	}
	const id = c.req.param("id");
	if (!id || id.length > 64) {
		return c.json({ success: false, message: "Not found" }, 404);
	}
	const revoked = await c
		.get("repositories")
		.managementApiKeys.revokeByIdInAccount(
			id,
			account,
			new Date().toISOString(),
			c.get("principal").userId
		);
	if (!revoked) return c.json({ success: false, message: "Not found" }, 404);
	return c.json({ success: true });
});
