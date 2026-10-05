/** Fixed-key Web configuration API. Never return a webhook URL except from explicit reveal. */
import { Hono, type Context } from "hono";
import {
	BILLING_CURRENCY_KEY,
	tryParseGatewaySupportedBillingCurrencyInput,
} from "@octafuse/core/lib/billing-currency";
import { isRouteStrategyName } from "@octafuse/core/db/model-route-policy";
import { ROUTE_STRATEGY_KEY } from "@octafuse/core/lib/route-strategy-system-config";
import {
	ALERT_WEBHOOK_FEISHU_URL_KEY,
	ALERT_WEBHOOK_WECOM_URL_KEY,
} from "@octafuse/core/lib/alert-webhook-system-config";
import type { AdminEnv } from "@/lib/admin-env";
import { hasAdminPermission } from "@/lib/admin-principal";
import { updateAdminSystemConfigService } from "@/lib/services/admin/dashboard-service";
import {
	configRevisionConflict,
	configRevisionError,
	configRevisionPrecondition,
} from "./config-revision";

type WebhookChannel = "wecom" | "feishu";
const WEBHOOK_KEYS: Record<WebhookChannel, string> = {
	wecom: ALERT_WEBHOOK_WECOM_URL_KEY,
	feishu: ALERT_WEBHOOK_FEISHU_URL_KEY,
};

export const adminManagedConfigRoutes = new Hono<AdminEnv>();

function channelKey(channel: string): string | null {
	return channel === "wecom" || channel === "feishu"
		? WEBHOOK_KEYS[channel]
		: null;
}

function canReadSecrets(c: Context<AdminEnv>): boolean {
	const principal = c.get("principal");
	return (
		hasAdminPermission(principal, "config.read") &&
		hasAdminPermission(principal, "config.secrets.read")
	);
}

function canWrite(c: Context<AdminEnv>): boolean {
	return hasAdminPermission(c.get("principal"), "config.write");
}

async function readValueBody(c: Context<AdminEnv>): Promise<string | null> {
	try {
		const body: unknown = await c.req.json();
		if (!body || typeof body !== "object" || Array.isArray(body)) return null;
		if (Object.keys(body).length !== 1 || !Object.hasOwn(body, "value"))
			return null;
		const value = (body as { value: unknown }).value;
		return typeof value === "string" ? value : null;
	} catch {
		return null;
	}
}

function validWebhookUrl(channel: string, value: string): boolean {
	if (
		!value ||
		value.length > 2048 ||
		/[\u0000-\u001f\u007f-\u009f]/u.test(value)
	)
		return false;
	try {
		const parsed = new URL(value);
		const officialHost =
			channel === "wecom" ? "qyapi.weixin.qq.com" : "open.feishu.cn";
		return (
			parsed.protocol === "https:" &&
			parsed.hostname === officialHost &&
			!parsed.port &&
			!parsed.username &&
			!parsed.password &&
			!parsed.hash
		);
	} catch {
		return false;
	}
}

const badInput = {
	success: false as const,
	message: "Invalid configuration value",
};
const readFailed = {
	success: false as const,
	message: "Failed to read configuration",
};
const writeFailed = {
	success: false as const,
	message: "Failed to update configuration",
};
adminManagedConfigRoutes.put("/billing-currency", async (c) => {
	if (!canWrite(c))
		return c.json({ success: false, message: "Forbidden" }, 403);
	const precondition = configRevisionPrecondition(c);
	if (precondition.kind === "absent" || precondition.kind === "invalid")
		return configRevisionError(c, precondition.kind);
	const raw = await readValueBody(c);
	const value =
		raw == null ? null : tryParseGatewaySupportedBillingCurrencyInput(raw);
	if (!value) return c.json(badInput, 400);
	try {
		const repos = c.get("repositories");
		const result = await updateAdminSystemConfigService(
			repos,
			{ key: BILLING_CURRENCY_KEY, value },
			c.get("principal"),
			precondition.kind === "match" ? precondition.revision : null
		);
		if (!result.committed) return configRevisionConflict(c);
		return c.json({
			success: true,
			data: {
				billingCurrency: {
					value,
					source: "configured",
					revision: result.revision,
				},
			},
		});
	} catch {
		return c.json(writeFailed, 500);
	}
});

adminManagedConfigRoutes.put("/route-strategy", async (c) => {
	if (!canWrite(c))
		return c.json({ success: false, message: "Forbidden" }, 403);
	const precondition = configRevisionPrecondition(c);
	if (precondition.kind === "absent" || precondition.kind === "invalid")
		return configRevisionError(c, precondition.kind);
	const raw = await readValueBody(c);
	const value = raw?.trim().toLowerCase();
	if (!value || !isRouteStrategyName(value)) return c.json(badInput, 400);
	try {
		const repos = c.get("repositories");
		const result = await updateAdminSystemConfigService(
			repos,
			{ key: ROUTE_STRATEGY_KEY, value },
			c.get("principal"),
			precondition.kind === "match" ? precondition.revision : null
		);
		if (!result.committed) return configRevisionConflict(c);
		return c.json({
			success: true,
			data: {
				routeStrategy: {
					value,
					source: "configured",
					revision: result.revision,
				},
			},
		});
	} catch {
		return c.json(writeFailed, 500);
	}
});

adminManagedConfigRoutes.put("/webhooks/:channel", async (c) => {
	if (!canWrite(c))
		return c.json({ success: false, message: "Forbidden" }, 403);
	const precondition = configRevisionPrecondition(c);
	if (precondition.kind === "absent" || precondition.kind === "invalid")
		return configRevisionError(c, precondition.kind);
	const channel = c.req.param("channel");
	const key = channelKey(channel);
	if (!key) return c.json(badInput, 404);
	const raw = await readValueBody(c);
	if (raw === null || /[\u0000-\u001f\u007f-\u009f]/u.test(raw))
		return c.json(badInput, 400);
	const value = raw?.trim() ?? "";
	if (!validWebhookUrl(channel, value)) return c.json(badInput, 400);
	try {
		const repos = c.get("repositories");
		const result = await updateAdminSystemConfigService(
			repos,
			{ key, value },
			c.get("principal"),
			precondition.kind === "match" ? precondition.revision : null
		);
		if (!result.committed) return configRevisionConflict(c);
		return c.json({
			success: true,
			data: { webhook: { configured: true, revision: result.revision } },
		});
	} catch {
		return c.json(writeFailed, 500);
	}
});

adminManagedConfigRoutes.delete("/webhooks/:channel", async (c) => {
	if (!canWrite(c))
		return c.json({ success: false, message: "Forbidden" }, 403);
	const precondition = configRevisionPrecondition(c);
	if (precondition.kind === "absent" || precondition.kind === "invalid")
		return configRevisionError(c, precondition.kind);
	const key = channelKey(c.req.param("channel"));
	if (!key) return c.json(badInput, 404);
	try {
		const repos = c.get("repositories");
		const result = await updateAdminSystemConfigService(
			repos,
			{ key, value: "" },
			c.get("principal"),
			precondition.kind === "match" ? precondition.revision : null
		);
		if (!result.committed) return configRevisionConflict(c);
		return c.json({
			success: true,
			data: { webhook: { configured: false, revision: result.revision } },
		});
	} catch {
		return c.json(writeFailed, 500);
	}
});

adminManagedConfigRoutes.get("/webhooks/:channel/reveal", async (c) => {
	const key = channelKey(c.req.param("channel"));
	if (!key) return c.json(badInput, 404);
	if (!canReadSecrets(c))
		return c.json({ success: false, message: "Forbidden" }, 403);
	try {
		const value = await c.get("repositories").systemConfig.getConfig(key);
		return c.json({
			success: true,
			data: { channel: c.req.param("channel"), value: value ?? "" },
		});
	} catch {
		return c.json(readFailed, 500);
	}
});

adminManagedConfigRoutes.post("/webhooks/:channel/verify", async (c) => {
	const channel = c.req.param("channel");
	const key = channelKey(channel);
	if (!key) return c.json(badInput, 404);
	if (!canReadSecrets(c))
		return c.json({ success: false, message: "Forbidden" }, 403);
	const value = await readValueBody(c);
	if (
		value === null ||
		value.length > 2048 ||
		/[\u0000-\u001f\u007f-\u009f]/u.test(value) ||
		(value.trim() !== "" && !validWebhookUrl(channel, value.trim()))
	)
		return c.json(badInput, 400);
	try {
		const current = await c.get("repositories").systemConfig.getConfig(key);
		return c.json({
			success: true,
			data: {
				channel: c.req.param("channel"),
				matched: (current ?? "") === value.trim(),
				configured: Boolean(current?.trim()),
			},
		});
	} catch {
		return c.json(readFailed, 500);
	}
});
