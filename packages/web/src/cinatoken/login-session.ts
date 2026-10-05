import type { LoginOptions } from './auth-popup'
import type { PortalMe } from './contracts'
import type { SessionSnapshot } from './session'

/** Login completion is distinct from the live proof required by ConsoleGate. */
export function confirmsRestoredLogin(
	session: SessionSnapshot,
	verifiedUser: PortalMe,
	intent: LoginOptions['intent']
): boolean {
	if (
		session.isRefreshing ||
		session.isLoggingOut ||
		session.isSwitchingWorkspace
	)
		return false
	if (intent !== 'admin') return session.status === 'authenticated'
	return (
		(session.status === 'authenticated' || session.status === 'unavailable') &&
		session.user?.userId === verifiedUser.userId &&
		session.user.subject === verifiedUser.subject
	)
}
