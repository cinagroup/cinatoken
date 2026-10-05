import { CinaTokenApiError } from '../../api'
import {
	isAccountContextMismatch,
	isUserMismatch,
	isWorkspaceMismatch,
} from '../account-access'

export function presetAccessFailure(error: unknown): boolean {
	return (
		error instanceof CinaTokenApiError &&
		(error.status === 401 ||
			error.status === 403 ||
			error.code === 'invalid-response' ||
			isAccountContextMismatch(error))
	)
}
export function presetErrorKey(error: unknown): string {
	const prefix = 'cinatoken.presets.'
	if (error instanceof CinaTokenApiError) {
		if (isUserMismatch(error)) return 'cinatoken.account.sessionChanged'
		if (isWorkspaceMismatch(error)) return 'cinatoken.shell.workspaceChanged'
		if (error.status === 400 || error.status === 413) return prefix + 'invalid'
		if (error.status === 403) return prefix + 'forbidden'
		if (error.status === 404) return prefix + 'notFound'
		if (error.status === 409) return prefix + 'conflict'
	}
	return prefix + 'failed'
}
