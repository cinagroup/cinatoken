import { CinaTokenApiError } from '../api'

export function isWorkspaceMismatch(error: unknown): boolean {
	return (
		error instanceof CinaTokenApiError && error.code === 'workspace-mismatch'
	)
}

export function isUserMismatch(error: unknown): boolean {
	return error instanceof CinaTokenApiError && error.code === 'user-mismatch'
}

export function isAccountContextMismatch(error: unknown): boolean {
	return isUserMismatch(error) || isWorkspaceMismatch(error)
}

export function invalidatesAccountAccess(error: unknown): boolean {
	return (
		error instanceof CinaTokenApiError &&
		(error.status === 401 ||
			error.status === 403 ||
			isAccountContextMismatch(error))
	)
}

/** Re-read server context after a rejected precondition, without replaying writes.
 * A malformed response (status 0) needs a resource retry, not repeated scope resets.
 */
export function requiresSessionRevalidation(error: unknown): boolean {
	return (
		error instanceof CinaTokenApiError &&
		(error.status === 401 ||
			(error.status === 409 && isAccountContextMismatch(error)))
	)
}
