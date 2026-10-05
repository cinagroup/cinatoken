export function modelErrorStatus(error: unknown): number {
	if (
		typeof error === 'object' &&
		error !== null &&
		'status' in error &&
		typeof error.status === 'number'
	)
		return error.status
	return 0
}
export function modelAccessDenied(error: unknown): boolean {
	return [401, 403].includes(modelErrorStatus(error))
}
export function modelInvalidResponse(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		error.code === 'invalid-response'
	)
}
export function modelWriteNeedsReconciliation(error: unknown): boolean {
	if (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error.code === 'unknown' || error.code === 'storage')
	)
		return true
	const status = modelErrorStatus(error)
	return status === 0 || status >= 500 || modelInvalidResponse(error)
}
export function modelErrorKey(error: unknown): string {
	if (typeof error === 'object' && error !== null && 'serverCode' in error) {
		if (error.serverCode === 'model_route_policy_conflict')
			return 'cinatoken.adminDomain.policyConflict'
		if (error.serverCode === 'model_route_policy_precondition_required')
			return 'cinatoken.adminDomain.policyPrecondition'
	}
	const prefix = 'cinatoken.adminModels.'
	if (modelAccessDenied(error)) return prefix + 'accessDenied'
	if (modelInvalidResponse(error)) return prefix + 'invalidResponse'
	if (modelErrorStatus(error) === 409) return prefix + 'conflict'
	if (modelErrorStatus(error) === 404) return prefix + 'notFound'
	if ([400, 413].includes(modelErrorStatus(error))) return prefix + 'validation'
	return prefix + 'requestFailed'
}
