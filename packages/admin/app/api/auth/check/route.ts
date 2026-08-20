/**
 * 供前端校验数据库中的真实 Session，并实时复核 CinaAuth 管理角色。
 */
import { authenticateAdminRequest } from '@/lib/auth';
import { resolveAdminRequestRuntime } from '@/lib/admin-request-runtime';
import { verifyCinaAuthConsolePrincipal } from '@/lib/cinaauth/principal';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
		const { bindings, storage } = await resolveAdminRequestRuntime(request);
		const principal = await authenticateAdminRequest(request, storage.repositories);
		const verified = principal
			? await verifyCinaAuthConsolePrincipal(request, principal, bindings)
			: null;
		if (verified) {
			return Response.json(
				{ authenticated: true, principalType: verified.type },
				{ headers: { 'Cache-Control': 'no-store' } },
			);
		}

		return Response.json(
			{ authenticated: false },
			{ headers: { 'Cache-Control': 'no-store' } },
		);
  } catch (error) {
    console.error('Auth check error:', error);
    return Response.json(
      { authenticated: false },
			{ status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
