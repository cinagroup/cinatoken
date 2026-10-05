export function providerErrorStatus(error: unknown): number {
	if (
		typeof error === 'object' &&
		error !== null &&
		'status' in error &&
		typeof error.status === 'number'
	)
		return error.status
	return 0
}
export function providerAccessDenied(error: unknown): boolean {
	return (
		providerErrorStatus(error) === 401 || providerErrorStatus(error) === 403
	)
}
export function providerInvalidResponse(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		error.code === 'invalid-response'
	)
}
export function providerErrorKey(error: unknown): string {
	const prefix = 'cinatoken.adminProviders.'
	if (providerAccessDenied(error)) return prefix + 'accessDenied'
	if (providerInvalidResponse(error)) return prefix + 'invalidResponse'
	const status = providerErrorStatus(error)
	if (status === 409) return prefix + 'conflict'
	if (status === 400 || status === 413) return prefix + 'invalidInput'
	if (status === 404) return prefix + 'notFound'
	return prefix + 'requestFailed'
}
