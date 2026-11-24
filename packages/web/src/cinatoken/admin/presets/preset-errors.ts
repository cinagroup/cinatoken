/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { AdminDomainWriteError } from '../domain-write-recovery'

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
	if (
		error instanceof AdminDomainWriteError &&
		(error.code === 'subject' ||
			error.serverCode === 'invalid_console_subject_precondition' ||
			error.serverCode === 'console_subject_required' ||
			error.serverCode === 'console_subject_mismatch')
	)
		return true
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
	if (error instanceof AdminDomainWriteError) {
		if (error.code === 'storage')
			return 'cinatoken.adminDomain.storageUnavailable'
		if (
			error.code === 'subject' ||
			error.serverCode === 'invalid_console_subject_precondition' ||
			error.serverCode === 'console_subject_required' ||
			error.serverCode === 'console_subject_mismatch'
		)
			return prefix + 'accessDenied'
		if (error.serverCode === 'invalid_admin_resource_id')
			return prefix + 'precondition'
	}
	if (adminPresetInvalidResponse(error)) return prefix + 'invalidResponse'
	if (adminPresetAccessLost(error)) return prefix + 'accessDenied'
	const status = adminPresetErrorStatus(error)
	if (status === 400 || status === 413 || status === 422)
		return prefix + 'invalidInput'
	if (status === 404) return prefix + 'notFound'
	if (status === 409) return prefix + 'conflict'
	if (status === 412 || status === 428) return prefix + 'precondition'
	return prefix + 'requestFailed'
}

export function adminPresetCanResumeMetadata(error: unknown): boolean {
	return (
		error instanceof AdminDomainWriteError &&
		error.code === 'rejected' &&
		error.serverCode === null &&
		[400, 413, 422].includes(error.status)
	)
}

export function adminPresetWriteHintKey(error: unknown): string | null {
	if (!(error instanceof AdminDomainWriteError)) return null
	if (error.code === 'unknown') return 'cinatoken.adminPresets.writeUnknown'
	if (error.code === 'rejected' && !adminPresetAccessLost(error))
		return 'cinatoken.adminPresets.writeRejected'
	return null
}
