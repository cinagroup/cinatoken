/**
 * 供前端校验数据库中的真实 Session，并实时复核 CinaAuth 管理角色。
 */
import { authenticateAdminRequest } from "@/lib/auth";
import { resolveAdminRequestRuntime } from "@/lib/admin-request-runtime";
import { handleGatewayApiError } from "@/lib/api-error";
import { withGatewayReadRetry } from "@/lib/gateway-read-retry";
import { createAdminAuthCheckResponse } from "@/lib/cinaauth/auth-check";

export const dynamic = "force-dynamic";

async function checkSession(request: Request): Promise<Response> {
	try {
		const { bindings, storage } = await resolveAdminRequestRuntime(request);
		const principal = await authenticateAdminRequest(
			request,
			storage.repositories
		);
		return await createAdminAuthCheckResponse(request, principal, bindings);
	} catch (error) {
		// An unavailable database cannot prove either authentication or logout.
		// Keep cookies untouched; the UI treats non-2xx checks as indeterminate.
		return handleGatewayApiError({ route: "auth.check", error });
	}
}

export const GET = (request: Request) =>
	withGatewayReadRetry(request, checkSession);
