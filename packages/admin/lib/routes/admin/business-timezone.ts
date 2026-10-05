/**
 * 管理路由：`/admin/business-timezone` — 返回当前 `system_config.BUSINESS_TIMEZONE`。
 */
import { Hono } from "hono";
import { resolveBusinessTimezoneConfiguration } from "@octafuse/core/lib/business-timezone";
import type { AdminEnv } from "@/lib/admin-env";
import { requireAdminPrincipal } from "@/lib/middleware/admin-auth";
import { handleAdminRouteError } from "./error-response";

export const adminBusinessTimezoneRoutes = new Hono<AdminEnv>();

adminBusinessTimezoneRoutes.use("*", async (c, next) => {
	await next();
	c.header("Cache-Control", "private, no-store");
});
adminBusinessTimezoneRoutes.use("*", requireAdminPrincipal);

adminBusinessTimezoneRoutes.get("/", async (c) => {
	try {
		const repos = c.get("repositories");
		const raw = await repos.systemConfig.getConfig("BUSINESS_TIMEZONE");
		const resolved = resolveBusinessTimezoneConfiguration(raw);
		return c.json({
			success: true,
			data: {
				business_timezone: resolved.businessTimezone,
				source: resolved.source,
			},
		});
	} catch (error) {
		return handleAdminRouteError(c, error, "Failed to get business timezone");
	}
});
