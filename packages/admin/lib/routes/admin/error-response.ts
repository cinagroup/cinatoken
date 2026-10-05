/**
 * 管理路由统一错误响应：将 `AdminServiceError` 映射为 JSON，其余记日志并返回 500。
 */
import type { Context } from "hono";
import { isAdminServiceError } from "@/lib/services/admin/errors";
import { handleGatewayApiError } from "@/lib/api-error";
import { isTransientPostgresConnectionError } from "@octafuse/core/storage/postgres-connection-error";
import { ModelPolicyPreconditionError } from "@/lib/services/admin/domain-contract";

/** 返回 `{ success: false, message }` JSON，不经过 Hono `c.json`（与部分路由错误体一致）。 */
export function jsonErr(c: Context, status: number, message: string) {
	return new Response(JSON.stringify({ success: false as const, message }), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

/**
 * `AdminServiceError` → 对应 status；否则 500 并打日志。
 */
export function handleAdminRouteError(
	c: Context,
	error: unknown,
	fallbackMessage: string
) {
	if (error instanceof ModelPolicyPreconditionError)
		return c.json(
			{ success: false, code: error.code, message: error.message },
			error.status
		);
	if (isAdminServiceError(error)) {
		return jsonErr(c, error.status, error.message);
	}
	if (isTransientPostgresConnectionError(error)) {
		return handleGatewayApiError({ route: c.req.path, error });
	}
	console.error("[admin] route error:", error);
	return jsonErr(c, 500, fallbackMessage);
}
