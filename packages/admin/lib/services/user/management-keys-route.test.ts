import assert from "node:assert/strict";
import test from "node:test";
import type {
	GatewayRepositories,
	InsertManagementApiKeyParams,
	ManagementApiKeyRow,
	WorkspaceAccessProjection,
} from "@octafuse/core";
import { Hono } from "hono";
import { getAccountCapabilities } from "@/lib/unified-session";
import type { UserEnv } from "@/lib/user-env";
import { userManagementKeysRoutes } from "@/lib/routes/user/management-keys";

const personalWorkspace: WorkspaceAccessProjection = {
	id: "personal:user-1",
	name: "Default",
	slug: "default",
	description: null,
	scopeType: "personal",
	organizationId: null,
	organizationName: null,
	organizationSlug: null,
	personalOwnerUserId: "user-1",
	isDefault: true,
	status: "active",
	role: "owner",
	accessSource: "personal_owner",
	createdAt: "2026-08-31T00:00:00.000Z",
	updatedAt: "2026-08-31T00:00:00.000Z",
};

function fixture(workspace: WorkspaceAccessProjection = personalWorkspace) {
	let inserted: InsertManagementApiKeyParams | null = null;
	let revokedActor = "";
	const repositories = {
		users: {
			getById: async (id: string) =>
				id === "user-1"
					? {
							id,
							status: "active",
							email: "user@example.com",
					  }
					: null,
		},
		managementApiKeys: {
			insert: async (params: InsertManagementApiKeyParams) => {
				inserted = params;
			},
			getByIdInAccount: async (id: string) => {
				if (!inserted || inserted.id !== id) return null;
				return {
					id: inserted.id,
					key_hash: inserted.keyHash,
					key_preview: inserted.keyPreview,
					account_type: inserted.accountType,
					personal_owner_user_id: inserted.personalOwnerUserId,
					organization_id: inserted.organizationId,
					name: inserted.name,
					status: "active",
					expires_at: inserted.expiresAt,
					last_used_at: null,
					created_by_user_id: inserted.createdByUserId,
					created_at: inserted.nowIso,
					updated_at: inserted.nowIso,
				} satisfies ManagementApiKeyRow;
			},
			listByAccount: async () => [],
			revokeByIdInAccount: async (
				_id: string,
				_account: unknown,
				_now: string,
				actorUserId: string
			) => {
				revokedActor = actorUserId;
				return true;
			},
		},
	} as unknown as GatewayRepositories;
	const app = new Hono<UserEnv>();
	app.use("*", async (c, next) => {
		c.set("repositories", repositories);
		c.set("principal", {
			userId: "user-1",
			subject: "subject-1",
			email: "user@example.com",
			isAdmin: false,
			capabilities: getAccountCapabilities(false),
		});
		c.set("workspaceContext", {
			workspaces: [workspace],
			currentWorkspace: workspace,
			preferredWorkspaceAvailable: true,
		});
		await next();
	});
	app.route("/management-keys", userManagementKeysRoutes);
	return {
		app,
		getInserted: () => inserted,
		getRevokedActor: () => revokedActor,
	};
}

test("portal owner creates a hash-only Management key and receives plaintext once", async () => {
	const { app, getInserted } = fixture();
	const response = await app.request("/management-keys", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name: "Deployment automation" }),
	});
	assert.equal(response.status, 201);
	assert.equal(response.headers.get("Cache-Control"), "private, no-store");
	const body = (await response.json()) as {
		success: boolean;
		key: string;
		data: Record<string, unknown>;
	};
	assert.equal(body.success, true);
	assert.match(body.key, /^sk-cina-mgmt-[0-9a-f]{64}$/u);
	assert.equal(body.data.name, "Deployment automation");
	const stored = getInserted();
	assert.ok(stored);
	assert.match(stored.keyHash, /^sha256:[0-9a-f]{64}$/u);
	assert.equal(JSON.stringify(stored).includes(body.key), false);
});

test("portal rejects expired Management keys before storage", async () => {
	const { app, getInserted } = fixture();
	const response = await app.request("/management-keys", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			name: "Expired",
			expires_at: "2020-01-01T00:00:00.000Z",
		}),
	});
	assert.equal(response.status, 400);
	assert.equal(getInserted(), null);
});

test("organization members cannot manage account-wide Management keys", async () => {
	const memberWorkspace: WorkspaceAccessProjection = {
		...personalWorkspace,
		id: "organization:org-1",
		scopeType: "organization",
		organizationId: "org-1",
		organizationName: "Example Org",
		organizationSlug: "example-org",
		personalOwnerUserId: null,
		role: "member",
		accessSource: "organization_default",
	};
	const { app } = fixture(memberWorkspace);
	assert.equal((await app.request("/management-keys")).status, 403);
});

test("portal revocation attributes the authenticated user to the audit write", async () => {
	const { app, getRevokedActor } = fixture();
	const response = await app.request("/management-keys/management-1", {
		method: "DELETE",
	});
	assert.equal(response.status, 200);
	assert.equal(getRevokedActor(), "user-1");
});
