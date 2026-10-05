/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
const prefix = 'cinatoken.adminEndpoints.'

export function endpointErrorStatus(error: unknown): number {
	if (
		typeof error === 'object' &&
		error !== null &&
		'status' in error &&
		typeof error.status === 'number'
	)
		return error.status
	return 0
}

export function endpointAccessDenied(error: unknown): boolean {
	return (
		endpointErrorStatus(error) === 401 || endpointErrorStatus(error) === 403
	)
}

export function endpointInvalidResponse(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		error.code === 'invalid-response'
	)
}

export function endpointWriteNeedsReconciliation(error: unknown): boolean {
	const status = endpointErrorStatus(error)
	return (
		status === 0 ||
		status === 404 ||
		status === 409 ||
		status >= 500 ||
		endpointInvalidResponse(error)
	)
}

export function endpointErrorKey(error: unknown): string {
	if (endpointAccessDenied(error)) return prefix + 'accessDenied'
	if (endpointInvalidResponse(error)) return prefix + 'invalidResponse'
	const status = endpointErrorStatus(error)
	if (status === 409) return prefix + 'conflict'
	if (status === 400 || status === 413) return prefix + 'invalidInput'
	if (status === 404) return prefix + 'notFound'
	return prefix + 'requestFailed'
}
