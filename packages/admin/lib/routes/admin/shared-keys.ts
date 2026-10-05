/** Safe bounded Shared Keys reads and atomic audited governance. */
import { Hono } from "hono";
import type { Context } from "hono";
import type { AdminEnv } from "@/lib/admin-env";
import { requireAdminPrincipal } from "@/lib/middleware/admin-auth";
import { SharedKeyAdminError } from "@/lib/services/admin/shared-key-admin-contract";
import {
	EXPECTED_CONSOLE_SUBJECT_HEADER,
	ExpectedConsoleSubjectError,
} from "@/lib/services/admin/expected-console-subject";
import {
	getAdminSharedKeyAudit,
	getAdminSharedKeyDetail,
	listAdminSharedKeys,
	mutateAdminSharedKey,
} from "@/lib/services/admin/shared-keys-service";
import { handleAdminRouteError } from "./error-response";

export const adminSharedKeysRoutes = new Hono<AdminEnv>();
adminSharedKeysRoutes.use("*", async (c, next) => {
	await next();
	c.header("Cache-Control", "private, no-store");
});
adminSharedKeysRoutes.use("*", requireAdminPrincipal);

function failure(c: Context, error: unknown, message: string) {
	if (
		error instanceof SharedKeyAdminError ||
		error instanceof ExpectedConsoleSubjectError
	)
		return c.json(
			{ success: false, code: error.code, message: error.message },
			error.status
		);
	return handleAdminRouteError(c, error, message);
}
adminSharedKeysRoutes.get("/", async (c) => {
	try {
		const result = await listAdminSharedKeys(
			c.get("repositories"),
			c.get("principal"),
			c.env ?? {},
			c.req.url,
			true
		);
		const { items, total, hasMore, ...context } = result;
		return c.json({
			success: true,
			data: items,
			total,
			truncated: hasMore,
			...context,
		});
	} catch (error) {
		return failure(c, error, "Failed to list shared keys");
	}
});
adminSharedKeysRoutes.get("/overview", async (c) => {
	try {
		return c.json({
			success: true,
			data: await listAdminSharedKeys(
				c.get("repositories"),
				c.get("principal"),
				c.env ?? {},
				c.req.url
			),
		});
	} catch (error) {
		return failure(c, error, "Failed to list shared keys");
	}
});
adminSharedKeysRoutes.get("/:id/detail", async (c) => {
	try {
		return c.json({
			success: true,
			data: await getAdminSharedKeyDetail(
				c.get("repositories"),
				c.get("principal"),
				c.env ?? {},
				c.req.param("id"),
				c.req.url
			),
		});
	} catch (error) {
		return failure(c, error, "Failed to read shared key");
	}
});
adminSharedKeysRoutes.get("/:id/audit", async (c) => {
	try {
		return c.json({
			success: true,
			data: await getAdminSharedKeyAudit(
				c.get("repositories"),
				c.get("principal"),
				c.req.param("id"),
				c.req.url
			),
		});
	} catch (error) {
		return failure(c, error, "Failed to read shared key audit");
	}
});
for (const method of ["patch", "delete"] as const) {
	adminSharedKeysRoutes[method]("/:id", async (c) => {
		try {
			const data = await mutateAdminSharedKey(
				c.get("repositories"),
				c.get("principal"),
				c.env ?? {},
				c.req.param("id"),
				c.req.url,
				await c.req.text(),
				method === "patch" ? "update" : "delete",
				c.req.header(EXPECTED_CONSOLE_SUBJECT_HEADER) ?? null
			);
			return c.json({
				success: true,
				data,
				message:
					method === "patch" ? "Shared key updated" : "Shared key deleted",
			});
		} catch (error) {
			return failure(c, error, "Failed to govern shared key");
		}
	});
}
