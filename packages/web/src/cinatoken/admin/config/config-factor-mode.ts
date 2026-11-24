/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type {
	AdminConfigFactorMode,
	AdminConfigOverview,
} from './config-contracts'

export function configFactorModeIdentity(reconciliationKey: string): {
	expectedUserId: string
	expectedConsoleSubject: string
} | null {
	try {
		const value: unknown = JSON.parse(reconciliationKey)
		if (
			!Array.isArray(value) ||
			value.length !== 3 ||
			!Number.isSafeInteger(value[2])
		)
			return null
		const [userId, subject] = value
		if (
			typeof userId !== 'string' ||
			!userId ||
			userId.trim() !== userId ||
			userId.length > 600 ||
			typeof subject !== 'string' ||
			!subject ||
			subject.trim() !== subject ||
			subject.length > 600 ||
			/[\p{Cc}\p{Cf}]/u.test(userId + subject)
		)
			return null
		return { expectedUserId: userId, expectedConsoleSubject: subject }
	} catch {
		return null
	}
}

export function factorModeDirty(
	field: AdminConfigOverview['userChargedCostFactorMode'],
	draft: AdminConfigFactorMode | null
): boolean {
	if (!field) return false
	return (
		field.source !== 'configured' || (draft !== null && draft !== field.value)
	)
}
