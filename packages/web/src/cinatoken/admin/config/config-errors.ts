/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	ConfigTimezoneInputError,
	ConfigWebhookInputError,
} from './config-contracts'
import { ConfigRecoveryPersistenceError } from './config-recovery-persistence'

function status(error: unknown): number {
	return typeof error === 'object' &&
		error !== null &&
		'status' in error &&
		typeof error.status === 'number'
		? error.status
		: 0
}

export function configAccessLost(error: unknown): boolean {
	return status(error) === 401 || status(error) === 403
}

export function configInvalidResponse(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		error.code === 'invalid-response'
	)
}

export function configWriteUncertain(error: unknown): boolean {
	if (
		error instanceof ConfigTimezoneInputError ||
		error instanceof ConfigWebhookInputError
	)
		return false
	const code = status(error)
	return (
		code === 0 ||
		code === 404 ||
		code === 409 ||
		code >= 500 ||
		configInvalidResponse(error)
	)
}

export function configErrorKey(error: unknown): string {
	const prefix = 'cinatoken.adminConfigTimezone.'
	if (error instanceof ConfigTimezoneInputError)
		return prefix + 'invalidTimezone'
	if (error instanceof ConfigRecoveryPersistenceError)
		return (
			prefix +
			(error.phase === 'mark' ? 'storageUnavailable' : 'storageCleanupFailed')
		)
	if (configAccessLost(error)) return prefix + 'accessDenied'
	if (configInvalidResponse(error)) return prefix + 'invalidResponse'
	const code = status(error)
	if (code === 400 || code === 413) return prefix + 'invalidTimezone'
	if (code === 409 || code === 412) return prefix + 'conflict'
	return prefix + 'requestFailed'
}
