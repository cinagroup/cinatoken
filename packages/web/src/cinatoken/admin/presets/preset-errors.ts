/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
export function adminPresetErrorStatus(error: unknown): number {
	return typeof error === 'object' &&
		error !== null &&
		'status' in error &&
		typeof error.status === 'number'
		? error.status
		: 0
}

export function adminPresetInvalidResponse(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		error.code === 'invalid-response'
	)
}

export function adminPresetAccessLost(error: unknown): boolean {
	const status = adminPresetErrorStatus(error)
	return status === 401 || status === 403
}

export function adminPresetReadFailed(error: unknown): boolean {
	return (
		adminPresetAccessLost(error) ||
		adminPresetInvalidResponse(error) ||
		adminPresetErrorStatus(error) >= 500
	)
}

export function adminPresetWriteUncertain(error: unknown): boolean {
	const status = adminPresetErrorStatus(error)
	if (typeof error === 'object' && error !== null && 'code' in error) {
		if (error.code === 'rejected' || error.code === 'subject') return false
		if (error.code === 'unknown' || error.code === 'storage') return true
	}
	return status === 0 || status >= 500 || adminPresetInvalidResponse(error)
}

export function adminPresetErrorKey(error: unknown): string {
	const prefix = 'cinatoken.adminPresets.'
	if (adminPresetInvalidResponse(error)) return prefix + 'invalidResponse'
	if (adminPresetAccessLost(error)) return prefix + 'accessDenied'
	const status = adminPresetErrorStatus(error)
	if (status === 400 || status === 413) return prefix + 'invalidInput'
	if (status === 404) return prefix + 'notFound'
	return prefix + 'requestFailed'
}
