/**
 * 管理路由：`/admin/budget-audit-logs` — 全站 API 密钥预算审计日志（多维筛选分页）。
 */
import { Hono } from "hono";
import type { AdminEnv } from "@/lib/admin-env";
import { requireAdminPrincipal } from "@/lib/middleware/admin-auth";
import {
	listAdminGlobalBudgetAuditLogFilterOptionsService,
	listAdminGlobalBudgetAuditLogsService,
} from "@/lib/services/admin/dashboard-service";
import { handleAdminRouteError } from "./error-response";
import { normalizeApiTimeFields } from "@octafuse/core/lib/time-format";
import { parseBudgetAuditLogQuery } from "@/lib/services/admin/budget-audit-log-query";
import { exportAdminGlobalBudgetAuditLogsService } from "@/lib/services/admin/budget-audit-log-export";
export const adminBudgetAuditLogsRoutes = new Hono<AdminEnv>();

adminBudgetAuditLogsRoutes.use("*", requireAdminPrincipal);

adminBudgetAuditLogsRoutes.get("/filters", async (c) => {
	try {
		const repos = c.get("repositories");
		const result = await listAdminGlobalBudgetAuditLogFilterOptionsService(
			repos
		);
		return c.json({ success: true as const, data: result });
	} catch (error) {
		return handleAdminRouteError(
			c,
			error,
			"Failed to get budget audit log filter options"
		);
	}
});

adminBudgetAuditLogsRoutes.get("/export.csv", async (c) => {
	try {
		const query = parseBudgetAuditLogQuery(
			new URL(c.req.url).searchParams,
			"export"
		);
		const csv = await exportAdminGlobalBudgetAuditLogsService(
			c.get("repositories"),
			query.filters,
			{ signal: c.req.raw.signal }
		);
		return new Response(csv, {
			status: 200,
			headers: {
				"Content-Type": "text/csv; charset=utf-8",
				"Content-Disposition": 'attachment; filename="budget-audit-logs.csv"',
				"X-Content-Type-Options": "nosniff",
				"Cache-Control": "private, no-store",
			},
		});
	} catch (error) {
		return handleAdminRouteError(
			c,
			error,
			"Failed to export budget audit logs"
		);
	}
});

/** 查询参数：page、page_size、user_id、api_key_id、user_email、event_type（可重复）、actor_type（可重复）、actor_id、actor_kind（可重复）、reason_code（可重复）、source（可重复）、correlation_id、start_date、end_date。 */
adminBudgetAuditLogsRoutes.get("/", async (c) => {
	try {
		const repos = c.get("repositories");
		const query = parseBudgetAuditLogQuery(
			new URL(c.req.url).searchParams,
			"list"
		);
		const result = await listAdminGlobalBudgetAuditLogsService(repos, query);
		return c.json(
			normalizeApiTimeFields({
				success: true as const,
				data: result.logs,
				total: result.total,
				page: result.page,
				page_size: result.page_size,
			})
		);
	} catch (error) {
		return handleAdminRouteError(c, error, "Failed to get budget audit logs");
	}
});
