/**
 * 登出：删除 `admin_session` cookie。
 */
import { cookies } from 'next/headers';
import { getSessionToken, hashSessionToken } from '@/lib/auth';
import { resolveAdminRequestRuntime } from '@/lib/admin-request-runtime';
import { logAdminAuthEvent } from '@/lib/security-log';
import { rejectInvalidBrowserMutationOrigin } from '@/lib/browser-mutation';
import { CINATOKEN_SESSION_COOKIE } from '@/lib/unified-session';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const originRejection = rejectInvalidBrowserMutationOrigin(request);
    if (originRejection) return originRejection;

    const cookieStore = await cookies();
    const token = getSessionToken(request);
    if (token) {
      const { storage } = await resolveAdminRequestRuntime(request);
      const tokenHash = await hashSessionToken(token);
      await Promise.all([
        storage.repositories.adminAccess.deleteSession(tokenHash),
        storage.repositories.portalAccess.deleteSession(tokenHash),
      ]);
    }
    cookieStore.delete(CINATOKEN_SESSION_COOKIE);
    cookieStore.delete('admin_session');
    cookieStore.delete('user_session');

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
