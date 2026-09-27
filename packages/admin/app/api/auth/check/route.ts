/**
 * 供前端校验数据库中的真实 Session，并实时复核 CinaAuth 管理角色。
 */
import { authenticateAdminRequest } from '@/lib/auth';
import { resolveAdminRequestRuntime } from '@/lib/admin-request-runtime';
import { handleGatewayApiError } from '@/lib/api-error';
import { withGatewayReadRetry } from '@/lib/gateway-read-retry';
import {
	CinaAuthConsoleVerificationUnavailableError,
	verifyCinaAuthConsolePrincipal,
} from '@/lib/cinaauth/principal';

export const dynamic = 'force-dynamic';

async function checkSession(request: Request): Promise<Response> {
  try {
		const { bindings, storage } = await resolveAdminRequestRuntime(request);
		const principal = await authenticateAdminRequest(request, storage.repositories);
		if (!principal) {
			return Response.json(
				{ authenticated: false, verification: 'none' },
				{ headers: { 'Cache-Control': 'no-store' } },
			);
		}
		let verified: Awaited<ReturnType<typeof verifyCinaAuthConsolePrincipal>>;
		try {
			verified = await verifyCinaAuthConsolePrincipal(request, principal, bindings);
		} catch (error) {
			if (error instanceof CinaAuthConsoleVerificationUnavailableError) {
				// Keep the locally valid browser session visible during a transient IdP
				// outage. Every protected API request still performs the same live role
				// check and therefore remains fail-closed.
				return Response.json(
					{ authenticated: true, principalType: principal.type, verification: 'degraded' },
					{ headers: { 'Cache-Control': 'no-store' } },
				);
			}
			throw error;
		}
		if (verified) {
			return Response.json(
				{ authenticated: true, principalType: verified.type, verification: 'verified' },
				{ headers: { 'Cache-Control': 'no-store' } },
			);
		}

		return Response.json(
			{ authenticated: false, verification: 'rejected' },
			{ headers: { 'Cache-Control': 'no-store' } },
		);
  } catch (error) {
    // An unavailable database cannot prove either authentication or logout.
    // Keep cookies untouched; the UI treats non-2xx checks as indeterminate.
    return handleGatewayApiError({ route: 'auth.check', error });
  }
}

export const GET = (request: Request) => withGatewayReadRetry(request, checkSession);
