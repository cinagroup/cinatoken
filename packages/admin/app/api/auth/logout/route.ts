/**
 * 统一登出：撤销浏览器携带的门户/管理员会话，再清理会话与工作区 Cookie。
 */
import { cookies } from 'next/headers';
import { resolveAdminRequestRuntime } from '@/lib/admin-request-runtime';
import { logAdminAuthEvent } from '@/lib/security-log';
import { rejectInvalidBrowserMutationOrigin } from '@/lib/browser-mutation';
import { CINATOKEN_SESSION_COOKIE, getAllBrowserSessionTokens } from '@/lib/unified-session';
import { revokeCinaAuthBrowserSessions } from '@/lib/cinaauth/revoke-sessions';
import { WORKSPACE_COOKIE } from '@/lib/workspace-cookie';
import { clearCinaAuthTransactionCookies } from '@/lib/cinaauth/logout-cookies';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const originRejection = rejectInvalidBrowserMutationOrigin(request);
    if (originRejection) return originRejection;

    const cookieStore = await cookies();
    const tokens = getAllBrowserSessionTokens(request);
    if (tokens.length) {
      const { storage } = await resolveAdminRequestRuntime(request);
      await revokeCinaAuthBrowserSessions(tokens, storage.repositories);
    }
    cookieStore.delete(CINATOKEN_SESSION_COOKIE);
    cookieStore.delete('admin_session');
    cookieStore.delete('user_session');
    cookieStore.delete(WORKSPACE_COOKIE);
    clearCinaAuthTransactionCookies(cookieStore);

    logAdminAuthEvent('admin.auth.logout', request);

    return Response.json({
      success: true,
      message: 'Logout successful',
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    console.error('Logout API error:', error);
    return Response.json(
      { success: false, message: 'Internal server error' },
      { status: 500, headers: { 'Cache-Control': 'private, no-store' } }
    );
  }
}
