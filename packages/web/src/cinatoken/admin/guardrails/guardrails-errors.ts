/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { AdminDomainWriteError } from '../domain-write-recovery'

function status(error: unknown): number {
	return typeof error === 'object' &&
		error !== null &&
		'status' in error &&
		typeof error.status === 'number'
		? error.status
		: 0
}

function invalidResponse(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		error.code === 'invalid-response'
	)
}

export function adminGuardrailAccessLost(error: unknown): boolean {
	if (
		error instanceof AdminDomainWriteError &&
		(error.code === 'subject' ||
			error.serverCode === 'invalid_console_subject_precondition' ||
			error.serverCode === 'console_subject_required' ||
			error.serverCode === 'console_subject_mismatch')
	)
		return true
	return status(error) === 401 || status(error) === 403
}

export function adminGuardrailReadFailed(error: unknown): boolean {
	return (
		adminGuardrailAccessLost(error) ||
		invalidResponse(error) ||
		status(error) >= 500
	)
}

export function adminGuardrailWriteUncertain(error: unknown): boolean {
	if (error instanceof AdminDomainWriteError)
		return error.code === 'unknown' || error.code === 'storage'
	const code = status(error)
	return code === 0 || code >= 500 || invalidResponse(error)
}

export function adminGuardrailWriteRejected(error: unknown): boolean {
	if (error instanceof AdminDomainWriteError) return error.code === 'rejected'
	const code = status(error)
	return code === 404 || code === 409
}

export function adminGuardrailErrorKey(error: unknown): string {
	const prefix = 'cinatoken.adminGuardrails.'
	if (error instanceof AdminDomainWriteError) {
		if (error.code === 'storage')
			return 'cinatoken.adminDomain.storageUnavailable'
		if (error.serverCode === 'invalid_admin_resource_id')
			return prefix + 'precondition'
	}
	if (invalidResponse(error)) return prefix + 'invalidResponse'
	if (adminGuardrailAccessLost(error)) return prefix + 'accessDenied'
	const code = status(error)
	if (code === 400 || code === 413 || code === 422)
		return prefix + 'invalidInput'
	if (code === 404) return prefix + 'notFound'
	if (code === 409) return prefix + 'conflict'
	if (code === 412 || code === 428) return prefix + 'precondition'
	return prefix + 'requestFailed'
}

export function adminGuardrailCanResumeBinding(error: unknown): boolean {
	return (
		error instanceof AdminDomainWriteError &&
		error.code === 'rejected' &&
		error.serverCode === null &&
		[400, 413, 422].includes(error.status)
	)
}

/** Both editable forms use the same definitive, uncoded field-rejection contract. */
export const adminGuardrailCanResumeMetadata = adminGuardrailCanResumeBinding

export function adminGuardrailWriteHintKey(error: unknown): string | null {
	if (!(error instanceof AdminDomainWriteError)) return null
	if (error.code === 'unknown') return 'cinatoken.adminGuardrails.writeUnknown'
	if (error.code === 'rejected' && !adminGuardrailAccessLost(error))
		return 'cinatoken.adminGuardrails.writeRejected'
	return null
}
