/**
 * 用户路由：`/user/shared-keys` — 卖家共享密钥上架/管理。
 * 明文密钥仅创建响应回显一次；列表只返回掩码 + 指纹。
 */
import { Hono, type Context } from "hono";
import {
	fingerprintProviderApiKey,
	getSharedChannelDefinition,
	isSharedKeyChannelType,
	maskProviderApiKeyForAdmin,
	roundGatewayMoney,
	sharedKeyStateExpectation,
	SHARED_KEY_CHANNEL_TYPES,
} from "@octafuse/core";
import type { SellerSharedKeyPatch, SharedKeyRow } from "@octafuse/core";
import {
	BILLING_CURRENCY_KEY,
	normalizeBillingCurrencyCode,
} from "@octafuse/core/lib/billing-currency";
import type { UserEnv } from "@/lib/user-env";
import { loadPortalMarketplaceConfig } from "@/lib/portal-config";
import { validateSharedKey } from "@/lib/shared-key-validation";
import { isSharedKeyEarningHistoryDeleteError } from "../shared-key-history-error";
import { projectCurrentSellerCreditedUsage } from "@/lib/shared-key-credited-usage-reader";
import { projectSellerCreditedUsageWithSignedClaims } from "@/lib/shared-key-signed-stats-reader";

export const userSharedKeysRoutes = new Hono<UserEnv>();

userSharedKeysRoutes.use("*", async (c, next) => {
	c.header("Cache-Control", "private, no-store");
	if (!c.get("principal").capabilities?.includes("shared_keys.manage")) {
		return c.json(
			{ success: false, message: "Shared key access is not available" },
			403
		);
	}
	await next();
});

type CreateSharedKeyBody = {
	channelType?: unknown;
	apiKey?: unknown;
	label?: unknown;
	weight?: unknown;
	inputPrice?: unknown;
	outputPrice?: unknown;
	cacheReadPrice?: unknown;
	cacheWritePrice?: unknown;
};

type UpdateSharedKeyBody = {
	label?: unknown;
	weight?: unknown;
	status?: unknown;
	inputPrice?: unknown;
	outputPrice?: unknown;
	cacheReadPrice?: unknown;
	cacheWritePrice?: unknown;
};

const toPrice = (value: unknown): number | null => {
	if (value === null || value === undefined || value === "") return null;
	const num = Number(value);
	if (!Number.isFinite(num) || num < 0) return null;
	return roundGatewayMoney(num);
};

const toWeight = (value: unknown): number | null => {
	if (value === undefined || value === null) return null;
	const num = Number(value);
	if (!Number.isInteger(num) || num < 1 || num > 100) return null;
	return num;
};

function maskSharedKey(row: SharedKeyRow) {
	const { apiKey, failureReason, ...rest } = row;
	const secret = apiKey.trim();
	// Older stored transport failures may echo credentials; do not expose them in cached lists.
	const safeFailureReason =
		failureReason && secret
			? failureReason.replaceAll(secret, "[redacted]")
			: failureReason;
	return {
		...rest,
		failureReason: safeFailureReason,
		apiKeyMasked: maskProviderApiKeyForAdmin(apiKey),
	};
}

async function projectSellerRows(
	c: Context<UserEnv>,
	rows: SharedKeyRow[]
): Promise<SharedKeyRow[]> {
	if (c.env?.SIGNED_SELLER_STATS_READER === "reviewed-v1") {
		return projectSellerCreditedUsageWithSignedClaims(
			c.get("repositories"),
			rows,
			c.get("principal").userId,
			c.req.raw,
			c.env
		);
	}
	if (c.env?.SHARED_KEY_CREDITED_USAGE_READER === "reviewed-v1") {
		return projectCurrentSellerCreditedUsage(
			c.get("repositories"),
			rows,
			c.get("principal").userId
		);
	}
	return rows;
}

userSharedKeysRoutes.get("/", async (c) => {
	c.header("Cache-Control", "private, no-store");
	const repositories = c.get("repositories");
	const sellerUserId = c.get("principal").userId;
	const rows = await repositories.sharedKeys.listSharedKeysBySeller(
		sellerUserId
	);
	const projected = await projectSellerRows(c, rows);
	return c.json({
		success: true,
		sellerUserId,
		// The current settlement ledger records USD, independently of quote currency.
		// Do not relabel accumulated ledger amounts with today's billing configuration.
		earningsCurrency: "USD",
		data: projected.map(maskSharedKey),
	});
});

userSharedKeysRoutes.get("/channels", async (c) => {
	c.header("Cache-Control", "private, no-store");
	const repositories = c.get("repositories");
	const [config, billingCurrencyRaw] = await Promise.all([
		loadPortalMarketplaceConfig(repositories),
		repositories.systemConfig.getConfig(BILLING_CURRENCY_KEY),
	]);
	const allowed =
		config.enabledChannels.length > 0
			? SHARED_KEY_CHANNEL_TYPES.filter((item) =>
					config.enabledChannels.includes(item)
			  )
			: SHARED_KEY_CHANNEL_TYPES;
	const channels = allowed.map((channelType) => {
		const definition = getSharedChannelDefinition(channelType);
		return {
			channelType,
			label: definition?.label ?? channelType,
			modelsUrl: definition?.modelsUrl ?? null,
		};
	});
	return c.json({
		success: true,
		data: {
			billingCurrency: normalizeBillingCurrencyCode(billingCurrencyRaw),
			channels,
			limits: {
				maxInputPrice: config.maxInputPrice,
				maxOutputPrice: config.maxOutputPrice,
				commissionRate: config.commissionRate,
			},
		},
	});
});

userSharedKeysRoutes.post("/", async (c) => {
	const repositories = c.get("repositories");
	const principal = c.get("principal");
	if (
		typeof repositories.sharedKeys.completeSharedKeyValidation !== "function"
	) {
		return c.json(
			{
				success: false,
				message: "Shared key validation storage is unavailable",
			},
			503
		);
	}
	const body = (await c.req
		.json()
		.catch(() => null)) as CreateSharedKeyBody | null;

	const channelType =
		typeof body?.channelType === "string" ? body.channelType : "";
	const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
	const weight = toWeight(body?.weight) ?? 1;
	const inputPrice = toPrice(body?.inputPrice);
	const outputPrice = toPrice(body?.outputPrice);
	const label =
		typeof body?.label === "string" && body.label.trim()
			? body.label.trim().slice(0, 128)
			: null;
	const cacheReadPrice = toPrice(body?.cacheReadPrice);
	const cacheWritePrice = toPrice(body?.cacheWritePrice);

	if (!isSharedKeyChannelType(channelType)) {
		return c.json(
			{ success: false, message: "不支持的渠道（仅限官方渠道白名单）" },
			400
		);
	}
	if (apiKey.length < 8) {
		return c.json({ success: false, message: "API Key 格式无效" }, 400);
	}
	if (
		inputPrice === null ||
		outputPrice === null ||
		inputPrice === 0 ||
		outputPrice === 0
	) {
		return c.json({ success: false, message: "输入/输出单价必须大于 0" }, 400);
	}

	const config = await loadPortalMarketplaceConfig(repositories);
	if (
		config.enabledChannels.length > 0 &&
		!config.enabledChannels.includes(channelType)
	) {
		return c.json({ success: false, message: "该渠道当前未开放共享" }, 403);
	}
	if (
		inputPrice > config.maxInputPrice ||
		outputPrice > config.maxOutputPrice
	) {
		return c.json(
			{
				success: false,
				message: `单价超出上限（输入 ≤ ${config.maxInputPrice}，输出 ≤ ${config.maxOutputPrice} / 1M tokens）`,
			},
			400
		);
	}

	const fingerprint = fingerprintProviderApiKey(apiKey);
	const existing = await repositories.sharedKeys.listSharedKeysBySeller(
		principal.userId
	);
	if (existing.some((row) => row.keyFingerprint === fingerprint)) {
		return c.json(
			{ success: false, message: "该密钥已上架，请勿重复提交" },
			409
		);
	}

	const id = crypto.randomUUID();
	const nowIso = new Date().toISOString();
	await repositories.sharedKeys.insertSharedKey({
		id,
		sellerUserId: principal.userId,
		channelType,
		apiKey,
		keyFingerprint: fingerprint,
		label,
		weight,
		inputPrice,
		outputPrice,
		cacheReadPrice,
		cacheWritePrice,
		nowIso,
	});

	// Observe the created row before validation; governance may change while the upstream probe runs.
	const created = await repositories.sharedKeys.getSharedKeyById(id);
	if (!created || created.sellerUserId !== principal.userId) {
		return c.json(
			{ success: false, message: "Shared key changed during creation" },
			409
		);
	}
	if (created.status === "disabled") {
		return c.json(
			{ success: false, message: "Shared key was disabled during creation" },
			409
		);
	}
	// 上架即校验：官方渠道 models 端点确认 key 有效后才进入调度池
	const validation = await validateSharedKey(channelType, apiKey);
	if (validation.valid || !validation.inconclusive) {
		const completed = await repositories.sharedKeys.completeSharedKeyValidation(
			id,
			sharedKeyStateExpectation(created),
			{ valid: validation.valid, reason: validation.reason },
			new Date().toISOString()
		);
		if (!completed) {
			return c.json(
				{
					success: false,
					code: "shared_key_state_conflict",
					message:
						"Shared key changed during validation; refresh before retrying",
				},
				409
			);
		}
	}

	const row = await repositories.sharedKeys.getSharedKeyById(id);
	if (!row || row.sellerUserId !== principal.userId) {
		return c.json({ success: false, message: "创建失败" }, 500);
	}
	return c.json({
		success: true,
		data: {
			...maskSharedKey(row),
			// 明文仅此一次回显
			apiKey,
			validation: validation.valid
				? "active"
				: validation.inconclusive
				? "validating"
				: "invalid",
			validationReason: validation.valid ? null : validation.reason,
		},
	});
});

userSharedKeysRoutes.patch("/:id", async (c) => {
	const repositories = c.get("repositories");
	const principal = c.get("principal");
	const id = c.req.param("id");
	const row = await repositories.sharedKeys.getSharedKeyById(id);
	if (!row || row.sellerUserId !== principal.userId) {
		return c.json({ success: false, message: "Not found" }, 404);
	}
	const body = (await c.req
		.json()
		.catch(() => null)) as UpdateSharedKeyBody | null;
	if (!body) return c.json({ success: false, message: "Invalid body" }, 400);

	const config = await loadPortalMarketplaceConfig(repositories);
	const patch: SellerSharedKeyPatch = {};

	if (body.label !== undefined) {
		patch.label =
			typeof body.label === "string" && body.label.trim()
				? body.label.trim().slice(0, 128)
				: null;
	}
	const weight = toWeight(body.weight);
	if (weight !== null) patch.weight = weight;
	if (body.status !== undefined) {
		if (body.status !== "paused" && body.status !== "active") {
			return c.json(
				{ success: false, message: "status must be active|paused" },
				400
			);
		}
		if (row.status === "disabled") {
			return c.json({ success: false, message: "密钥已被管理员停用" }, 403);
		}
		if (
			!["active", "paused"].includes(row.status) ||
			(body.status === "active" &&
				row.status === "paused" &&
				row.validatedAt === null)
		) {
			return c.json(
				{ success: false, message: "密钥必须先成功重新验证，才能恢复共享调度" },
				400
			);
		}
		patch.status = body.status;
	}
	const inputPrice = toPrice(body.inputPrice);
	if (inputPrice !== null) {
		if (inputPrice === 0 || inputPrice > config.maxInputPrice) {
			return c.json({ success: false, message: "输入单价超出允许范围" }, 400);
		}
		patch.inputPrice = inputPrice;
	}
	const outputPrice = toPrice(body.outputPrice);
	if (outputPrice !== null) {
		if (outputPrice === 0 || outputPrice > config.maxOutputPrice) {
			return c.json({ success: false, message: "输出单价超出允许范围" }, 400);
		}
		patch.outputPrice = outputPrice;
	}
	if (body.cacheReadPrice !== undefined)
		patch.cacheReadPrice = toPrice(body.cacheReadPrice);
	if (body.cacheWritePrice !== undefined)
		patch.cacheWritePrice = toPrice(body.cacheWritePrice);

	if (Object.keys(patch).length === 0) {
		return c.json({ success: false, message: "无可更新字段" }, 400);
	}
	if (typeof repositories.sharedKeys.updateSharedKeyForSeller !== "function") {
		return c.json(
			{
				success: false,
				message: "Shared key conditional storage is unavailable",
			},
			503
		);
	}
	const written = await repositories.sharedKeys.updateSharedKeyForSeller(
		id,
		patch,
		sharedKeyStateExpectation(row)
	);
	if (!written) {
		return c.json(
			{
				success: false,
				code: "shared_key_state_conflict",
				message: "Shared key changed; refresh before retrying",
			},
			409
		);
	}
	const updated = await repositories.sharedKeys.getSharedKeyById(id);
	if (!updated || updated.sellerUserId !== principal.userId)
		return c.json({ success: false, message: "Not found" }, 404);
	const projected = updated ? (await projectSellerRows(c, [updated]))[0] : null;
	return c.json({
		success: true,
		data: projected ? maskSharedKey(projected) : null,
	});
});

userSharedKeysRoutes.delete("/:id", async (c) => {
	const repositories = c.get("repositories");
	const principal = c.get("principal");
	const id = c.req.param("id");
	const row = await repositories.sharedKeys.getSharedKeyById(id);
	if (!row || row.sellerUserId !== principal.userId) {
		return c.json({ success: false, message: "Not found" }, 404);
	}
	try {
		await repositories.sharedKeys.deleteSharedKey(id);
	} catch (error) {
		if (isSharedKeyEarningHistoryDeleteError(error)) {
			return c.json(
				{
					success: false,
					code: "shared_key_earning_history_immutable",
					message: "Shared key has credited earnings and cannot be deleted",
				},
				409
			);
		}
		throw error;
	}
	return c.json({ success: true });
});

userSharedKeysRoutes.post("/:id/revalidate", async (c) => {
	const repositories = c.get("repositories");
	const principal = c.get("principal");
	const id = c.req.param("id");
	const row = await repositories.sharedKeys.getSharedKeyById(id);
	if (!row || row.sellerUserId !== principal.userId) {
		return c.json({ success: false, message: "Not found" }, 404);
	}
	if (row.status === "disabled") {
		return c.json({ success: false, message: "密钥已被管理员停用" }, 403);
	}
	if (
		typeof repositories.sharedKeys.completeSharedKeyValidation !== "function"
	) {
		return c.json(
			{
				success: false,
				message: "Shared key validation storage is unavailable",
			},
			503
		);
	}
	const validation = await validateSharedKey(row.channelType, row.apiKey);
	const nowIso = new Date().toISOString();
	if (validation.valid || !validation.inconclusive) {
		const completed = await repositories.sharedKeys.completeSharedKeyValidation(
			id,
			sharedKeyStateExpectation(row),
			{ valid: validation.valid, reason: validation.reason },
			nowIso
		);
		if (!completed) {
			return c.json(
				{
					success: false,
					code: "shared_key_state_conflict",
					message:
						"Shared key changed during validation; refresh before retrying",
				},
				409
			);
		}
	}
	const updated = await repositories.sharedKeys.getSharedKeyById(id);
	if (!updated || updated.sellerUserId !== principal.userId)
		return c.json({ success: false, message: "Not found" }, 404);
	const projected = updated ? (await projectSellerRows(c, [updated]))[0] : null;
	return c.json({
		success: true,
		data: projected ? maskSharedKey(projected) : null,
	});
});
