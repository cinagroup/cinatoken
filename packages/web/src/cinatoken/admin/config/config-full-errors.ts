/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	ConfigTimezoneInputError,
	ConfigWebhookInputError,
} from './config-contracts'
import { configAccessLost, configInvalidResponse } from './config-errors'
import { ConfigRecoveryPersistenceError } from './config-recovery-persistence'

export function configFullErrorKey(error: unknown): string {
	const prefix = 'cinatoken.adminConfigFull.'
	if (error instanceof ConfigTimezoneInputError)
		return prefix + 'invalidTimezone'
	if (error instanceof ConfigWebhookInputError) return prefix + 'invalidWebhook'
	if (error instanceof ConfigRecoveryPersistenceError)
		return (
			prefix +
			(error.phase === 'mark' ? 'storageUnavailable' : 'storageCleanupFailed')
		)
	if (configAccessLost(error)) return prefix + 'accessDenied'
	if (configInvalidResponse(error)) return prefix + 'invalidResponse'
	if (typeof error === 'object' && error !== null && 'status' in error) {
		if (error.status === 400 || error.status === 413)
			return prefix + 'invalidSetting'
		if (error.status === 409 || error.status === 412) return prefix + 'conflict'
	}
	return prefix + 'requestFailed'
}
