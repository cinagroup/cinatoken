import { Hono, type Context } from "hono";
import type {
	AdminApiKeyAuditContext,
	AdminApiKeyAuditCursor,
	AdminApiKeyRow,
} from "@octafuse/core";
import type { AdminEnv } from "@/lib/admin-env";
import {
	ADMIN_PERMISSIONS,
	normalizeAdminPermissions,
	parseAdminPermissions,
} from "@/lib/admin-principal";
import { generateAdminApiKey } from "@/lib/auth";

export const adminAccessKeysRoutes = new Hono<AdminEnv>();

const SECRET_KEY_RE = /^sk-admin-[0-9a-f]{64}$/i;

function auditContext(c: Context<AdminEnv>): AdminApiKeyAuditContext {
	const principal = c.get("principal");
	if (principal?.type !== "console")
		throw new Error("Console principal required for Admin API key audit");
	return {
		auditId: crypto.randomUUID(),
		actorId: principal.id,
		nowIso: new Date().toISOString(),
	};
}

function encodeAuditCursor(
	keyId: string,
	cursor: AdminApiKeyAuditCursor
): string {
	return btoa(
		JSON.stringify({
			v: 1,
			key_id: encodeURIComponent(keyId),
			created_at: cursor.createdAt,
			id: cursor.id,
		})
	)
		.replace(/\+/gu, "-")
		.replace(/\//gu, "_")
		.replace(/=+$/u, "");
}
function parseAuditCursor(
	keyId: string,
	raw: string
): AdminApiKeyAuditCursor | null {
	if (!/^[A-Za-z0-9_-]{1,1024}$/u.test(raw)) return null;
	try {
		const value = JSON.parse(
			atob(raw.replace(/-/gu, "+").replace(/_/gu, "/"))
		) as Record<string, unknown>;
		if (
			value?.v !== 1 ||
			value.key_id !== encodeURIComponent(keyId) ||
			typeof value.created_at !== "string" ||
			typeof value.id !== "string" ||
			!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:\d{3})?Z$/u.test(
				value.created_at
			) ||
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
				value.id
			) ||
			!Number.isFinite(Date.parse(value.created_at)) ||
			new Date(value.created_at).toISOString() !==
				`${value.created_at.slice(0, 23)}Z`
		)
			return null;
		const cursor = { createdAt: value.created_at, id: value.id };
		return encodeAuditCursor(keyId, cursor) === raw ? cursor : null;
	} catch {
		return null;
	}
}

function publicKey(row: AdminApiKeyRow) {
	const safePrefix = row.keyPrefix.slice(
		0,
		Math.min(12, Math.max(0, row.secretKey.length - 4))
	);
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		key: `${safePrefix}••••••••`,
		key_prefix: safePrefix,
		permissions: parseAdminPermissions(row.permissionsJson),
		status: row.status,
		last_used_at: row.lastUsedAt,
		created_at: row.createdAt,
		updated_at: row.updatedAt,
		revoked_at: row.revokedAt,
	};
}

function parsePermissions(value: unknown): string[] | null {
	if (
		!Array.isArray(value) ||
		!value.every(
			(item) =>
				typeof item === "string" && ADMIN_PERMISSIONS.includes(item as never)
		)
	) {
		return null;
	}
	const normalized = normalizeAdminPermissions(value);
	return normalized.length > 0 ? normalized : null;
}

function isUniqueConflict(error: unknown): boolean {
	const message =
		error instanceof Error
			? error.message.toLowerCase()
			: String(error).toLowerCase();
	return message.includes("unique") || message.includes("duplicate");
}

function parseOptionalSecret(value: unknown): string | null | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !SECRET_KEY_RE.test(value.trim()))
		return null;
	return value.trim();
}

adminAccessKeysRoutes.get("/", async (c) => {
	const rows = await c.get("repositories").adminAccess.listApiKeys();
	return c.json({ success: true, data: rows.map(publicKey) });
});

adminAccessKeysRoutes.post("/", async (c) => {
	let body: {
		name?: unknown;
		description?: unknown;
		permissions?: unknown;
		secret_key?: unknown;
	};
	try {
		body = await c.req.json();
	} catch {
		return c.json({ success: false, message: "Invalid JSON body" }, 400);
	}
	const name = typeof body.name === "string" ? body.name.trim() : "";
	const permissions = parsePermissions(body.permissions);
	const providedSecret = parseOptionalSecret(body.secret_key);
	if (body.secret_key !== undefined && providedSecret === null) {
		return c.json({ success: false, message: "Invalid secret_key" }, 400);
	}
	if (!name || name.length > 255 || !permissions) {
		return c.json(
			{ success: false, message: "Invalid name or permissions" },
			400
		);
	}
	const secretKey = providedSecret ?? generateAdminApiKey();
	const id = crypto.randomUUID();
	try {
		await c.get("repositories").adminAccess.insertApiKey(
			{
				id,
				name,
				description:
					typeof body.description === "string"
						? body.description.trim() || null
						: null,
				secretKey,
				keyPrefix: secretKey.slice(0, 12),
				permissionsJson: JSON.stringify(permissions),
			},
			auditContext(c)
		);
	} catch (error) {
		if (isUniqueConflict(error))
			return c.json(
				{ success: false, message: "Admin API key name already exists" },
				409
			);
		throw error;
	}
	const row = await c.get("repositories").adminAccess.getApiKeyById(id);
	return c.json(
		{ success: true, data: { ...publicKey(row!), key: secretKey } },
		201
	);
});

adminAccessKeysRoutes.get("/:id/secret", async (c) => {
	const row = await c
		.get("repositories")
		.adminAccess.revealApiKeyWithAudit(c.req.param("id"), auditContext(c));
	if (!row)
		return c.json({ success: false, message: "Admin API key not found" }, 404);
	return c.json({ success: true, data: { id: row.id, key: row.secretKey } });
});

adminAccessKeysRoutes.post("/:id/rotate", async (c) => {
	const secretKey = generateAdminApiKey();
	const updated = await c
		.get("repositories")
		.adminAccess.rotateApiKey(c.req.param("id"), secretKey, auditContext(c));
	if (!updated)
		return c.json(
			{ success: false, message: "Active Admin API key not found" },
			404
		);
	return c.json({
		success: true,
		data: { id: c.req.param("id"), key: secretKey },
	});
});

adminAccessKeysRoutes.post("/:id/revoke", async (c) => {
	const updated = await c
		.get("repositories")
		.adminAccess.revokeApiKey(c.req.param("id"), auditContext(c));
	if (!updated)
		return c.json(
			{ success: false, message: "Active Admin API key not found" },
			404
		);
	return c.json({ success: true });
});

adminAccessKeysRoutes.get("/:id/audit", async (c) => {
	const id = c.req.param("id");
	const params = new URL(c.req.url).searchParams;
	if (
		[...params.keys()].some((key) => key !== "page_size" && key !== "cursor") ||
		params.getAll("page_size").length > 1 ||
		params.getAll("cursor").length > 1
	) {
		return c.json({ success: false, message: "Invalid audit query" }, 400);
	}
	const rawPageSize = params.get("page_size") ?? "50";
	if (!/^[1-9]\d{0,2}$/u.test(rawPageSize) || Number(rawPageSize) > 100)
		return c.json({ success: false, message: "Invalid page_size" }, 400);
	const pageSize = Number(rawPageSize);
	const cursor = params.has("cursor")
		? parseAuditCursor(id, params.get("cursor")!)
		: undefined;
	if (cursor === null)
		return c.json({ success: false, message: "Invalid cursor" }, 400);
	const repository = c.get("repositories").adminAccess;
	if (!(await repository.getApiKeyById(id)))
		return c.json({ success: false, message: "Admin API key not found" }, 404);
	const rows = await repository.listApiKeyAudit(id, {
		limit: pageSize + 1,
		...(cursor ? { before: cursor } : {}),
	});
	const entries = rows.slice(0, pageSize);
	return c.json({
		success: true,
		data: {
			entries: entries.map((row) => ({
				id: row.id,
				key_id: row.keyId,
				action: row.action,
				change_mask: row.changeMask,
				actor_kind: row.actorKind,
				actor_id: row.actorId,
				before_permissions: row.beforePermissions,
				after_permissions: row.afterPermissions,
				before_status: row.beforeStatus,
				after_status: row.afterStatus,
				created_at: row.createdAt,
			})),
			next_cursor:
				rows.length > pageSize ? encodeAuditCursor(id, entries.at(-1)!) : null,
		},
	});
});

adminAccessKeysRoutes.get("/:id", async (c) => {
	const row = await c
		.get("repositories")
		.adminAccess.getApiKeyById(c.req.param("id"));
	if (!row)
		return c.json({ success: false, message: "Admin API key not found" }, 404);
	return c.json({ success: true, data: publicKey(row) });
});

adminAccessKeysRoutes.patch("/:id", async (c) => {
	let body: {
		name?: unknown;
		description?: unknown;
		permissions?: unknown;
		status?: unknown;
		secret_key?: unknown;
	};
	try {
		body = await c.req.json();
	} catch {
		return c.json({ success: false, message: "Invalid JSON body" }, 400);
	}
	const patch: {
		name?: string;
		description?: string | null;
		permissionsJson?: string;
		secretKey?: string;
		status?: "active" | "revoked";
		revokedAt?: string | null;
	} = {};
	if (body.name !== undefined) {
		if (
			typeof body.name !== "string" ||
			!body.name.trim() ||
			body.name.trim().length > 255
		) {
			return c.json({ success: false, message: "Invalid name" }, 400);
		}
		patch.name = body.name.trim();
	}
	if (body.description !== undefined) {
		if (body.description !== null && typeof body.description !== "string") {
			return c.json({ success: false, message: "Invalid description" }, 400);
		}
		patch.description =
			typeof body.description === "string"
				? body.description.trim() || null
				: null;
	}
	if (body.permissions !== undefined) {
		const permissions = parsePermissions(body.permissions);
		if (!permissions)
			return c.json({ success: false, message: "Invalid permissions" }, 400);
		patch.permissionsJson = JSON.stringify(permissions);
	}
	if (body.status !== undefined) {
		if (body.status !== "active" && body.status !== "revoked") {
			return c.json({ success: false, message: "Invalid status" }, 400);
		}
		patch.status = body.status;
		patch.revokedAt =
			body.status === "revoked" ? new Date().toISOString() : null;
	}
	if (body.secret_key !== undefined) {
		const secretKey = parseOptionalSecret(body.secret_key);
		if (secretKey === null || secretKey === undefined) {
			return c.json({ success: false, message: "Invalid secret_key" }, 400);
		}
		patch.secretKey = secretKey;
	}
	if (Object.keys(patch).length === 0) {
		return c.json({ success: false, message: "No changes supplied" }, 400);
	}
	let updated: boolean;
	try {
		updated = await c
			.get("repositories")
			.adminAccess.updateApiKey(c.req.param("id"), patch, auditContext(c));
	} catch (error) {
		if (isUniqueConflict(error))
			return c.json(
				{ success: false, message: "Admin API key name already exists" },
				409
			);
		throw error;
	}
	if (!updated)
		return c.json(
			{
				success: false,
				message: "Admin API key not found or no changes supplied",
			},
			404
		);
	const row = await c
		.get("repositories")
		.adminAccess.getApiKeyById(c.req.param("id"));
	const payload =
		patch.secretKey != null
			? { ...publicKey(row!), key: patch.secretKey }
			: publicKey(row!);
	return c.json({ success: true, data: payload });
});
