import { authenticateAdminRequest } from '@/lib/auth';
import { authenticateUserRequest } from '@/lib/user-auth';
import { verifyCinaAuthConsolePrincipal } from './principal';

/** Reuse a valid session without rotating a unified administrator cookie into a portal-only one. */
export async function canResumeCinaAuthSession(
	request: Request,
	intent: 'admin' | 'portal',
	repositories: Parameters<typeof authenticateAdminRequest>[1] & Parameters<typeof authenticateUserRequest>[1],
	bindings?: { CINAAUTH_AUTH_SERVICE?: Fetcher },
): Promise<boolean> {
	if (intent === 'portal') return (await authenticateUserRequest(request, repositories)) !== null;
	const principal = await authenticateAdminRequest(request, repositories);
	if (principal?.type !== 'console') return false;
	return (await verifyCinaAuthConsolePrincipal(request, principal, bindings)) !== null;
}
