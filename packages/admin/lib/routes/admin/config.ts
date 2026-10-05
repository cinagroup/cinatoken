/**
 * 管理路由：`/admin/config` — 读写可管理的 `system_config`（禁止写入已移除的 MASTER_KEY）。
 */
import { Hono } from "hono";
import type { AdminEnv } from "@/lib/admin-env";
import { requireAdminPrincipal } from "@/lib/middleware/admin-auth";
import {
	listAdminSystemConfigService,
	updateAdminSystemConfigService,
} from "@/lib/services/admin/dashboard-service";
import type { AdminConfigUpdateInput } from "@/lib/services/admin/types";
import { handleAdminRouteError } from "./error-response";
import { hasAdminPermission } from "@/lib/admin-principal";
import {
	MASKED_ADMIN_SECRET,
	prepareAdminConfigRows,
} from "@/lib/admin-config-secrets";
import { loadAdminConfigOverview } from "./config-overview";
import { adminManagedConfigRoutes } from "./config-managed";
import { adminToolsConfigRoutes } from "./config-tools";
import { ToolConfigError } from "@/lib/services/admin/tool-config-contract";
import { toolConfigGenericFamily } from "@/lib/services/admin/tool-config-service";
import {
	toolConfigJson,
	exactObject,
	TOOL_CONFIG_OVERVIEW_KEYS,
} from "@/lib/services/admin/tool-config-input";
import {
	assertExpectedConsoleSubject,
	ExpectedConsoleSubjectError,
	EXPECTED_CONSOLE_SUBJECT_HEADER,
} from "@/lib/services/admin/expected-console-subject";
import {
	configRevisionConflict,
	configRevisionError,
	configRevisionPrecondition,
} from "./config-revision";
import { BILLING_CURRENCY_KEY } from "@octafuse/core/lib/billing-currency";
import { ROUTE_STRATEGY_KEY } from "@octafuse/core/lib/route-strategy-system-config";
import {
	ALERT_WEBHOOK_FEISHU_URL_KEY,
	ALERT_WEBHOOK_WECOM_URL_KEY,
} from "@octafuse/core/lib/alert-webhook-system-config";
export const adminConfigRoutes = new Hono<AdminEnv>();

/** Keep legacy writes available during staging, then enforce CAS before Web Config is exposed. */
const WEB_MANAGED_CONFIG_KEYS = new Set([
	"BUSINESS_TIMEZONE",
	BILLING_CURRENCY_KEY,
	ROUTE_STRATEGY_KEY,
	ALERT_WEBHOOK_WECOM_URL_KEY,
	ALERT_WEBHOOK_FEISHU_URL_KEY,
]);
/** Tools secrets are available only through the version-bound, audited reveal endpoint. */
const TOOLS_BULK_MASK_KEYS = new Set<string>(
	TOOL_CONFIG_OVERVIEW_KEYS.filter((key) => key !== BILLING_CURRENCY_KEY)
);

adminConfigRoutes.use("*", async (c, next) => {
	await next();
	c.header("Cache-Control", "private, no-store");
});
adminConfigRoutes.use("*", requireAdminPrincipal);

/** Fixed-key non-secret summary for the browser configuration page. */
adminConfigRoutes.get("/overview", async (c) => {
	const principal = c.get("principal");
	if (!hasAdminPermission(principal, "config.read")) {
		return c.json(
			{
				success: false,
				message: "Forbidden",
				required_permission: "config.read",
			},
			403
		);
	}
	try {
		return c.json({
			success: true,
			data: await loadAdminConfigOverview(c.get("repositories"), principal),
		});
	} catch {
		return c.json(
			{ success: false, message: "Failed to get config overview" },
			500
		);
	}
});

adminConfigRoutes.route("/", adminManagedConfigRoutes);
adminConfigRoutes.route("/tools", adminToolsConfigRoutes);

/** 列出全部 system_config 行。 */
adminConfigRoutes.get("/", async (c) => {
	try {
		const repos = c.get("repositories");
		const data = prepareAdminConfigRows(
			(await listAdminSystemConfigService(repos)).map((row) =>
				TOOLS_BULK_MASK_KEYS.has(row.key)
					? { key: row.key, value: MASKED_ADMIN_SECRET, description: null }
					: row
			),
			hasAdminPermission(c.get("principal"), "config.secrets.read")
		);
		return c.json({ success: true, data });
	} catch (error) {
		return handleAdminRouteError(c, error, "Failed to get config");
	}
});

/** 单键 upsert：body `{ key, value }`。 */
adminConfigRoutes.put("/", async (c) => {
	const precondition = configRevisionPrecondition(c);
	if (precondition.kind === "invalid") return configRevisionError(c, "invalid");
	let body: AdminConfigUpdateInput;
	try {
		const raw = await c.req.text();
		body = JSON.parse(raw);
		if (
			typeof body?.key === "string" &&
			toolConfigGenericFamily(body.key.trim())
		) {
			body = exactObject(
				toolConfigJson(raw),
				["key", "value", "tools_version", "reason", "accept_loss_pricing"],
				["key", "value"]
			) as AdminConfigUpdateInput;
			assertExpectedConsoleSubject(
				c.get("principal"),
				c.req.header(EXPECTED_CONSOLE_SUBJECT_HEADER),
				c.env.CINATOKEN_ADMIN_TOOLS_REQUIRE_VERSION === "true"
			);
		}
	} catch (error) {
		if (error instanceof Error && error.name === "BodyLimitError")
			return c.json(
				{ success: false, message: "Request body is too large" },
				413
			);
		if (
			error instanceof ToolConfigError ||
			error instanceof ExpectedConsoleSubjectError
		)
			return c.json(
				{ success: false, code: error.code, message: error.message },
				error.status
			);
		return c.json({ success: false, message: "Invalid JSON body" }, 400);
	}
	if (
		precondition.kind === "absent" &&
		c.env?.CINATOKEN_ADMIN_CONFIG_REQUIRE_REVISION === "true" &&
		typeof body?.key === "string" &&
		WEB_MANAGED_CONFIG_KEYS.has(body.key.trim())
	)
		return configRevisionError(c, "absent");
	try {
		const repos = c.get("repositories");
		if (
			typeof body?.key === "string" &&
			toolConfigGenericFamily(body.key.trim())
		) {
			const result = await updateAdminSystemConfigService(
				repos,
				body,
				c.get("principal"),
				precondition.kind === "absent"
					? undefined
					: precondition.kind === "match"
					? precondition.revision
					: null,
				{
					requireToolsVersion:
						c.env.CINATOKEN_ADMIN_TOOLS_REQUIRE_VERSION === "true",
				}
			);
			return c.json({
				success: true,
				message: "Config updated",
				revision: result.revision,
			});
		}
		if (precondition.kind === "absent") {
			await updateAdminSystemConfigService(repos, body, c.get("principal"));
			return c.json({ success: true, message: "Config updated" });
		}
		const result = await updateAdminSystemConfigService(
			repos,
			body,
			c.get("principal"),
			precondition.kind === "match" ? precondition.revision : null
		);
		if (!result.committed) return configRevisionConflict(c);
		return c.json({
			success: true,
			message: "Config updated",
			revision: result.revision,
		});
	} catch (error) {
		if (error instanceof ToolConfigError)
			return c.json(
				{ success: false, code: error.code, message: error.message },
				error.status
			);
		if (
			typeof body?.key === "string" &&
			toolConfigGenericFamily(body.key.trim())
		)
			return c.json(
				{
					success: false,
					code: "tools_operation_failed",
					message: "Tools configuration operation failed",
				},
				500
			);
		return handleAdminRouteError(c, error, "Failed to update config");
	}
});
