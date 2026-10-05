/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { CinaTokenApiError } from '../../api'

/** Preflight failure proves no protected operation was dispatched. */
export class AdminSharedKeySubjectError extends CinaTokenApiError {
	constructor() {
		super('Verified Console subject could not be confirmed', 403, 'http')
		this.name = 'AdminSharedKeySubjectError'
	}
}

export class AdminSharedKeyInputError extends Error {
	constructor() {
		super('Shared key input is invalid')
		this.name = 'AdminSharedKeyInputError'
	}
}
export class AdminSharedKeyPersistenceError extends Error {
	constructor() {
		super('Cannot retain Shared key operation marker')
		this.name = 'AdminSharedKeyPersistenceError'
	}
}
export function adminSharedKeyAccessDenied(error: unknown): boolean {
	return (
		error instanceof CinaTokenApiError &&
		(error.status === 401 || error.status === 403)
	)
}
export function adminSharedKeyWriteUnknown(error: unknown): boolean {
	if (
		error instanceof AdminSharedKeyInputError ||
		error instanceof AdminSharedKeyPersistenceError
	)
		return false
	return (
		!(error instanceof CinaTokenApiError) ||
		error.status === 0 ||
		error.status >= 500 ||
		['network', 'timeout', 'cancelled', 'invalid-response'].includes(error.code)
	)
}
/** API response text is never rendered or retained as a user-visible error. */
export function sanitizeSharedKeyError(error: unknown): CinaTokenApiError {
	if (error instanceof AdminSharedKeySubjectError) return error
	if (error instanceof CinaTokenApiError)
		return new CinaTokenApiError(
			'Shared key operation could not be confirmed',
			error.status,
			error.code
		)
	return new CinaTokenApiError(
		'Shared key operation could not be confirmed',
		0,
		'network'
	)
}
