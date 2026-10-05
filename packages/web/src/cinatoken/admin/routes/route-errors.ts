/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
export function routeErrorStatus(error: unknown): number {
	return typeof error === 'object' &&
		error !== null &&
		'status' in error &&
		typeof error.status === 'number'
		? error.status
		: 0
}
export function routeAccessDenied(error: unknown): boolean {
	const status = routeErrorStatus(error)
	return status === 401 || status === 403
}
export function routeInvalidResponse(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		error.code === 'invalid-response'
	)
}
export function routeUnknownWrite(error: unknown): boolean {
	if (error instanceof RouteInputError) return false
	const status = routeErrorStatus(error)
	return (
		status === 0 ||
		status === 404 ||
		status === 409 ||
		status >= 500 ||
		routeInvalidResponse(error)
	)
}
export function routeErrorKey(error: unknown): string {
	if (typeof error === 'object' && error !== null && 'serverCode' in error) {
		if (error.serverCode === 'model_route_policy_conflict')
			return 'cinatoken.adminDomain.policyConflict'
		if (error.serverCode === 'model_route_policy_precondition_required')
			return 'cinatoken.adminDomain.policyPrecondition'
	}
	const prefix = 'cinatoken.adminRoutes.'
	if (error instanceof RouteInputError) return prefix + 'invalidInput'
	if (routeAccessDenied(error)) return prefix + 'accessDenied'
	if (routeInvalidResponse(error)) return prefix + 'invalidResponse'
	const status = routeErrorStatus(error)
	if (status === 409) return prefix + 'conflict'
	if (status === 400 || status === 413) return prefix + 'invalidInput'
	if (status === 404) return prefix + 'notFound'
	return prefix + 'requestFailed'
}
/** Local validation failed before an HTTP write was issued. */
export class RouteInputError extends Error {}
