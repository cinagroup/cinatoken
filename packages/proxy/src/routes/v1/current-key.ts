import {
	MANAGEMENT_API_KEY_PREFIX,
	gatewayKeyLimitAmount,
	type ManagementApiKeyAccount,
	type ManagementApiKeyPrincipal,
	type ManagementApiKeyRow,
	type ManagementGatewayKeyRow,
} from "@octafuse/core";
import { Hono } from "hono";
import type { Env } from "../../app";
import { throttleAuthFailure } from "../../middleware/auth";
import { authenticateApiKey } from "../../services/api-key-auth";
import { GatewayErrorCode } from "../../services/gateway-error-codes";
import { gatewayErrorJson } from "../../services/gateway-error-response";
import { authenticateManagementApiKey } from "../../services/management-api-key-auth";

const DEPRECATED_RATE_LIMIT = {
	requests: -1,
	interval: "",
	note: "This field is deprecated and safe to ignore.",
} as const;

function bearerCredential(value: string | undefined): string | null {
	if (!value) return null;
	const match = /^Bearer[\t ]+([^\s]+)[\t ]*$/iu.exec(value);
	return match?.[1] ?? null;
}

function commonMetadata(options: {
	creatorUserId: string | null;
	expiresAt: string | null;
	isManagementKey: boolean;
	label: string;
	usage: number;
	usageDaily: number;
	usageWeekly: number;
	usageMonthly: number;
	limitMicros?: number | null;
	limitReset?: "daily" | "weekly" | "monthly" | null;
	includeByokInLimit?: boolean;
}) {
	const limit = gatewayKeyLimitAmount(options.limitMicros ?? null);
	const periodUsage = options.limitReset === "daily"
		? options.usageDaily
		: options.limitReset === "weekly"
			? options.usageWeekly
			: options.limitReset === "monthly"
				? options.usageMonthly
				: options.usage;
	return {
		byok_usage: 0,
		byok_usage_daily: 0,
		byok_usage_monthly: 0,
		byok_usage_weekly: 0,
		creator_user_id: options.creatorUserId,
		expires_at: options.expiresAt,
		include_byok_in_limit: options.includeByokInLimit ?? false,
		is_free_tier: false,
		is_management_key: options.isManagementKey,
		is_provisioning_key: options.isManagementKey,
		label: options.label,
		limit,
		limit_remaining: limit === null
			? null
			: Math.max(0, Math.round((limit - periodUsage) * 1_000_000) / 1_000_000),
		limit_reset: options.limitReset ?? null,
		rate_limit: DEPRECATED_RATE_LIMIT,
		usage: options.usage,
		usage_daily: options.usageDaily,
		usage_monthly: options.usageMonthly,
		usage_weekly: options.usageWeekly,
	};
}

function gatewayMetadata(row: ManagementGatewayKeyRow) {
	return commonMetadata({
		creatorUserId: row.user_id,
		expiresAt: row.expires_at,
		isManagementKey: false,
		label: row.key_preview,
		usage: row.usage,
		usageDaily: row.usage_daily,
		usageWeekly: row.usage_weekly,
		usageMonthly: row.usage_monthly,
		limitMicros: row.limit_micros,
		limitReset: row.limit_reset,
		includeByokInLimit: row.include_byok_in_limit,
	});
}

function managementAccount(
	principal: ManagementApiKeyPrincipal
): ManagementApiKeyAccount {
	return {
		accountType: principal.accountType,
		personalOwnerUserId: principal.personalOwnerUserId,
		organizationId: principal.organizationId,
	};
}

function managementMetadata(row: ManagementApiKeyRow) {
	return commonMetadata({
		creatorUserId: row.created_by_user_id,
		expiresAt: row.expires_at,
		isManagementKey: true,
		label: row.key_preview,
		usage: 0,
		usageDaily: 0,
		usageWeekly: 0,
		usageMonthly: 0,
	});
}

function isActiveManagementRow(row: ManagementApiKeyRow): boolean {
	if (row.status !== "active") return false;
	if (row.expires_at === null) return true;
	const expiresAt = Date.parse(row.expires_at);
	return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

async function unauthorized(c: Parameters<typeof gatewayErrorJson>[0]) {
	return (
		(await throttleAuthFailure(c)) ??
		gatewayErrorJson(c, {
			status: 401,
			code: GatewayErrorCode.authFailed,
			message: "Missing or invalid API key",
		})
	);
}

/** OpenRouter-compatible metadata for whichever Bearer credential is current. */
export const currentKeyRoutes = new Hono<Env>();

currentKeyRoutes.get("/", async (c) => {
	const secret = bearerCredential(c.req.header("Authorization"));
	if (!secret) return unauthorized(c);

	const repositories = c.get("repositories");
	if (secret.startsWith(MANAGEMENT_API_KEY_PREFIX)) {
		const principal = await authenticateManagementApiKey(repositories, secret);
		if (!principal) return unauthorized(c);
		const row = await repositories.managementApiKeys.getByIdInAccount(
			principal.keyId,
			managementAccount(principal)
		);
		if (!row || !isActiveManagementRow(row)) return unauthorized(c);
		c.header("Cache-Control", "private, no-store");
		return c.json({ data: managementMetadata(row) });
	}

	const principal = await authenticateApiKey(repositories, secret);
	if (!principal) return unauthorized(c);
	const row = await repositories.apiKeys.getCurrentById(principal.keyId);
	if (!row) return unauthorized(c);
	c.header("Cache-Control", "private, no-store");
	return c.json({ data: gatewayMetadata(row) });
});
