/**
 * 旧密码登录入口已停用；浏览器登录统一走 `/api/auth/cinaauth/login`。
 * `DELETE` 与 `/api/auth/logout` 类似，用于清除本地会话。
 */
import { hashSessionToken } from '@/lib/auth';
import { cookies } from 'next/headers';
import { resolveAdminRequestRuntime } from '@/lib/admin-request-runtime';
import { logAdminAuthEvent } from '@/lib/security-log';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
	logAdminAuthEvent('admin.auth.login_failed', request, { path: '/api/auth/login' });
	return Response.json(
		{ success: false, message: 'Password login is disabled; use CinaAuth.' },
		{ status: 410, headers: { 'Cache-Control': 'no-store' } },
	);
}

export async function DELETE(request: Request) {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get('admin_session')?.value;
    if (token) {
      const { storage } = await resolveAdminRequestRuntime();
      await storage.repositories.adminAccess.deleteSession(await hashSessionToken(token));
    }
    cookieStore.delete('admin_session');

    logAdminAuthEvent('admin.auth.logout', request);

    return Response.json({
      success: true,
      message: 'Logout successful',
    });
  } catch (error) {
    console.error('Logout API error:', error);
    return Response.json(
      { success: false, message: 'Internal server error' },
      { status: 500 }
    );
  }
}
