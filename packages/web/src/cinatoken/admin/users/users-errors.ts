/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { CinaTokenApiError } from '../../api'
import { UserInputError } from './users-input'
import { UsersWritePersistenceError } from './users-write-recovery'

export function userAccessDenied(error: unknown): boolean {
	return (
		error instanceof CinaTokenApiError &&
		(error.status === 401 || error.status === 403)
	)
}

export function userWriteOutcomeUnknown(error: unknown): boolean {
	if (!(error instanceof CinaTokenApiError)) return true
	return (
		error.status === 0 ||
		error.status >= 500 ||
		error.code === 'invalid-response' ||
		error.code === 'cancelled' ||
		error.code === 'timeout' ||
		error.code === 'network'
	)
}

export function userReadErrorKey(error: unknown): string {
	if (userAccessDenied(error)) return 'accessDenied'
	if (error instanceof CinaTokenApiError && error.code === 'invalid-response')
		return 'invalidResponse'
	return 'readFailed'
}

export function userWriteErrorKey(error: unknown): string {
	if (error instanceof UserInputError) return 'invalidInput'
	if (error instanceof UsersWritePersistenceError)
		return 'writeSafetyUnavailable'
	if (userWriteOutcomeUnknown(error)) return 'unknownWrite'
	if (userAccessDenied(error)) return 'writeDenied'
	if (error instanceof CinaTokenApiError && error.status === 409)
		return 'conflict'
	return 'writeFailed'
}
