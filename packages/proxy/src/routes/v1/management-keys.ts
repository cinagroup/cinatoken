import {
	createKey,
	defaultWorkspaceId,
	gatewayKeyLimitAmount,
	getAccessibleWorkspaceForSubject,
	hashLookupKey,
	normalizeGatewayKeyLimitMicros,
	normalizeGatewayKeyLimitReset,
	normalizeFutureKeyExpiry,
	type ManagementApiKeyAccount,
	type ManagementApiKeyPrincipal,
	type ManagementGatewayKeyLookupParams,
	type ManagementGatewayKeyRow,
	type ManagementGatewayKeyPatch,
} from "@octafuse/core";
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../../app";
import { requireManagementApiKey } from "../../middleware/management-auth";
import { GatewayErrorCode } from "../../services/gateway-error-codes";
import { gatewayErrorJson } from "../../services/gateway-error-response";

type ManagementKeysEnv = Env & {
	Variables: { managementKey: ManagementApiKeyPrincipal };
};

const KEY_HASH_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_NAME_LENGTH = 128;
const MAX_WORKSPACE_ID_LENGTH = 600;
const CREATE_FIELDS = new Set([
	"name",
	"creator_user_id",
	"expires_at",
	"external_api_key",
	"external_user",
	"include_byok_in_limit",
	"limit",
	"limit_reset",
	"workspace_id",
]);
const PATCH_FIELDS = new Set([
	"disabled",
	"include_byok_in_limit",
	"limit",
	"limit_reset",
	"name",
]);

type JsonObject = Record<string, unknown>;

function account(
	principal: ManagementApiKeyPrincipal
): ManagementApiKeyAccount {
	return {
		accountType: principal.accountType,
		personalOwnerUserId: principal.personalOwnerUserId,
		organizationId: principal.organizationId,
	};
}

function defaultWorkspace(principal: ManagementApiKeyPrincipal): string {
	const owner =
		principal.accountType === "personal"
			? principal.personalOwnerUserId
			: principal.organizationId;
	if (!owner) throw new TypeError("Management API key account is invalid");
	return defaultWorkspaceId(principal.accountType, owner);
}

function lookupParams(
	principal: ManagementApiKeyPrincipal,
	hash: string
): ManagementGatewayKeyLookupParams | null {
	if (!KEY_HASH_PATTERN.test(hash)) return null;
	return {
		...account(principal),
		keyHash: `sha256:${hash}`,
	};
}

function publicKey(row: ManagementGatewayKeyRow) {
	const limit = gatewayKeyLimitAmount(row.limit_micros);
	const periodUsage = gatewayKeyLimitAmount(row.limit_consumed_micros) ?? 0;
	const limitRemaining = limit === null
		? null
		: Math.max(0, Math.round((limit - periodUsage) * 1_000_000) / 1_000_000);
	return {
		byok_usage: row.byok_usage,
		byok_usage_daily: row.byok_usage_daily,
		byok_usage_monthly: row.byok_usage_monthly,
		byok_usage_weekly: row.byok_usage_weekly,
		created_at: row.created_at,
		creator_user_id: row.user_id,
		disabled: row.status !== "active",
		expires_at: row.expires_at,
		external_user: null,
		hash: row.key_hash.slice("sha256:".length),
		include_byok_in_limit: row.include_byok_in_limit,
		label: row.key_preview,
		limit,
		limit_remaining: limitRemaining,
		limit_reset: row.limit_reset,
		name: row.name,
		updated_at: row.updated_at,
		usage: row.usage,
		usage_daily: row.usage_daily,
		usage_monthly: row.usage_monthly,
		usage_weekly: row.usage_weekly,
		workspace_id: row.workspace_id,
	};
}

function invalid(c: Parameters<typeof gatewayErrorJson>[0], message: string) {
	return gatewayErrorJson(c, {
		status: 400,
		code: GatewayErrorCode.invalidRequest,
		message,
	});
}

function notFound(c: Parameters<typeof gatewayErrorJson>[0]) {
	return gatewayErrorJson(c, {
		status: 404,
		code: GatewayErrorCode.routeNotFound,
		message: "Resource not found",
	});
}

function forbidden(c: Parameters<typeof gatewayErrorJson>[0], message: string) {
	return gatewayErrorJson(c, {
		status: 403,
		code: GatewayErrorCode.permissionDenied,
		message,
	});
}

function asJsonObject(value: unknown): JsonObject | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as JsonObject)
		: null;
}

function hasOnlyFields(
	value: JsonObject,
	allowed: ReadonlySet<string>
): boolean {
	return Object.keys(value).every((field) => allowed.has(field));
}

function name(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	return normalized.length > 0 && normalized.length <= MAX_NAME_LENGTH
		? normalized
		: null;
}

function workspaceId(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	return normalized.length > 0 && normalized.length <= MAX_WORKSPACE_ID_LENGTH
		? normalized
		: null;
}

function limitFields(body: JsonObject): {
	limitMicros: number | null;
	limitReset: "daily" | "weekly" | "monthly" | null;
	includeByokInLimit: boolean;
} {
	if ("include_byok_in_limit" in body && typeof body.include_byok_in_limit !== "boolean") {
		throw new TypeError("include_byok_in_limit must be a boolean");
	}
	return {
		limitMicros: normalizeGatewayKeyLimitMicros(body.limit),
		limitReset: normalizeGatewayKeyLimitReset(body.limit_reset),
		includeByokInLimit: body.include_byok_in_limit === true,
	};
}

async function parseBody(c: Parameters<typeof gatewayErrorJson>[0]) {
	try {
		return asJsonObject(await c.req.json());
	} catch {
		return null;
	}
}

async function resolveCreator(
	c: Context<ManagementKeysEnv>,
	principal: ManagementApiKeyPrincipal,
	requested: unknown,
	workspace: string
): Promise<string | null> {
	if (
		requested !== undefined &&
		requested !== null &&
		typeof requested !== "string"
	) {
		return null;
	}
	const requestedId = typeof requested === "string" ? requested.trim() : "";
	if (requestedId.length > 512) return null;

	if (principal.accountType === "personal") {
		if (!principal.personalOwnerUserId) return null;
		return requestedId && requestedId !== principal.personalOwnerUserId
			? null
			: principal.personalOwnerUserId;
	}

	const creatorId = requestedId || principal.createdByUserId || "";
	if (!creatorId) return null;
	const repositories = c.get("repositories");
	const creator = await repositories.users.getById(creatorId);
	if (
		!creator ||
		creator.status !== "active" ||
		creator.external_system !== "cinaauth" ||
		!creator.external_user_id
	) {
		return null;
	}
	const accessible = await getAccessibleWorkspaceForSubject(
		repositories.client,
		{
			userId: creator.id,
			subject: creator.external_user_id,
			workspaceId: workspace,
		}
	);
	return accessible ? creator.id : null;
}

export const managementKeyRoutes = new Hono<ManagementKeysEnv>();

managementKeyRoutes.use("*", requireManagementApiKey);

managementKeyRoutes.get("/", async (c) => {
	const includeDisabledRaw = c.req.query("include_disabled");
	if (
		includeDisabledRaw !== undefined &&
		includeDisabledRaw !== "true" &&
		includeDisabledRaw !== "false"
	) {
		return invalid(c, "include_disabled must be true or false");
	}
	const offsetRaw = c.req.query("offset");
	const offset = offsetRaw === undefined ? 0 : Number(offsetRaw);
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) {
		return invalid(c, "offset must be a non-negative integer");
	}

	const principal = c.get("managementKey");
	const requestedWorkspace = c.req.query("workspace_id");
	const workspace =
		requestedWorkspace === undefined
			? defaultWorkspace(principal)
			: workspaceId(requestedWorkspace);
	if (!workspace) return invalid(c, "workspace_id is invalid");
	const repositories = c.get("repositories");
	if (
		!(await repositories.managementApiKeys.workspaceBelongsToAccount(
			workspace,
			account(principal)
		))
	) {
		return notFound(c);
	}

	const rows = await repositories.apiKeys.listForManagement({
		...account(principal),
		workspaceId: workspace,
		includeDisabled: includeDisabledRaw === "true",
		offset,
	});
	c.header("Cache-Control", "private, no-store");
	return c.json({ data: rows.map(publicKey) });
});

managementKeyRoutes.post("/", async (c) => {
	const body = await parseBody(c);
	if (!body || !hasOnlyFields(body, CREATE_FIELDS)) {
		return invalid(c, "Invalid request parameters");
	}
	if ("external_user" in body || "external_api_key" in body) {
		return forbidden(
			c,
			"Connect client fields are not accepted with a Management API key"
		);
	}
	let limits: ReturnType<typeof limitFields>;
	try {
		limits = limitFields(body);
	} catch (error) {
		return invalid(c, error instanceof Error ? error.message : "Invalid key limit");
	}
	const now = new Date();
	if (
		body.expires_at !== undefined &&
		body.expires_at !== null &&
		typeof body.expires_at !== "string"
	) {
		return invalid(c, "Gateway API key expiry is invalid");
	}
	let expiresAt: string | null;
	try {
		expiresAt = normalizeFutureKeyExpiry(
			body.expires_at as string | null | undefined,
			now.toISOString(),
			"Gateway"
		);
	} catch (error) {
		if (error instanceof TypeError) return invalid(c, error.message);
		throw error;
	}
	const normalizedName = name(body.name);
	if (!normalizedName) return invalid(c, "name is required");

	const principal = c.get("managementKey");
	const workspace =
		body.workspace_id === undefined
			? defaultWorkspace(principal)
			: workspaceId(body.workspace_id);
	if (!workspace) return invalid(c, "workspace_id is invalid");
	const repositories = c.get("repositories");
	if (
		!(await repositories.managementApiKeys.workspaceBelongsToAccount(
			workspace,
			account(principal)
		))
	) {
		return notFound(c);
	}
	const creatorId = await resolveCreator(
		c,
		principal,
		body.creator_user_id,
		workspace
	);
	if (!creatorId)
		return invalid(c, "creator_user_id is not authorized for this workspace");

	const created = await createKey(repositories, {
		user_id: creatorId,
		workspace_id: workspace,
		name: normalizedName,
		expires_at: expiresAt,
		limit_micros: limits.limitMicros,
		limit_reset: limits.limitReset,
		include_byok_in_limit: limits.includeByokInLimit,
		now,
		actor_id: `management_key:${principal.keyId}`,
		actor_type: "service",
		provision_reason: "Gateway key provisioned through Management API",
	});
	const keyHash = await hashLookupKey(created.key);
	const row = await repositories.apiKeys.getByHashForManagement({
		...account(principal),
		keyHash,
	});
	if (!row) throw new Error("Created Gateway key was not observable");
	c.header("Cache-Control", "private, no-store");
	return c.json({ data: publicKey(row), key: created.key }, 201);
});

managementKeyRoutes.get("/:hash", async (c) => {
	const principal = c.get("managementKey");
	const params = lookupParams(principal, c.req.param("hash"));
	if (!params) return notFound(c);
	const row = await c
		.get("repositories")
		.apiKeys.getByHashForManagement(params);
	if (!row) return notFound(c);
	c.header("Cache-Control", "private, no-store");
	return c.json({ data: publicKey(row) });
});

managementKeyRoutes.patch("/:hash", async (c) => {
	const principal = c.get("managementKey");
	const params = lookupParams(principal, c.req.param("hash"));
	if (!params) return notFound(c);
	const repositories = c.get("repositories");
	const current = await repositories.apiKeys.getByHashForManagement(params);
	if (!current) return notFound(c);
	const body = await parseBody(c);
	if (
		!body ||
		!hasOnlyFields(body, PATCH_FIELDS) ||
		Object.keys(body).length === 0
	) {
		return invalid(c, "Invalid request parameters");
	}
	const patch: ManagementGatewayKeyPatch = {};
	if ("name" in body) {
		const normalizedName = name(body.name);
		if (!normalizedName) return invalid(c, "name is invalid");
		patch.name = normalizedName;
	}
	if ("disabled" in body) {
		if (typeof body.disabled !== "boolean") {
			return invalid(c, "disabled must be a boolean");
		}
		patch.status = body.disabled ? "disabled" : "active";
	}
	try {
		if ("limit" in body) patch.limitMicros = normalizeGatewayKeyLimitMicros(body.limit);
		if ("limit_reset" in body) patch.limitReset = normalizeGatewayKeyLimitReset(body.limit_reset);
		if ("include_byok_in_limit" in body) {
			if (typeof body.include_byok_in_limit !== "boolean") {
				throw new TypeError("include_byok_in_limit must be a boolean");
			}
			patch.includeByokInLimit = body.include_byok_in_limit;
		}
	} catch (error) {
		return invalid(c, error instanceof Error ? error.message : "Invalid key limit");
	}
	if (Object.keys(patch).length === 0) {
		return invalid(c, "No supported update fields were provided");
	}
	await repositories.apiKeys.updateByHashForManagement(params, patch);
	const updated = await repositories.apiKeys.getByHashForManagement(params);
	if (!updated) return notFound(c);
	c.header("Cache-Control", "private, no-store");
	return c.json({ data: publicKey(updated) });
});

managementKeyRoutes.delete("/:hash", async (c) => {
	const principal = c.get("managementKey");
	const params = lookupParams(principal, c.req.param("hash"));
	if (!params) return notFound(c);
	const repositories = c.get("repositories");
	const current = await repositories.apiKeys.getByHashForManagement(params);
	if (!current) return notFound(c);
	if (!(await repositories.apiKeys.deleteByHashForManagement(params))) {
		return invalid(c, "API key with usage history or requests in flight cannot be deleted; disable it instead");
	}
	c.header("Cache-Control", "private, no-store");
	return c.json({ deleted: true });
});
