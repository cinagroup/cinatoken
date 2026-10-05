/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */

export type ConfigPendingStorage = Pick<
	Storage,
	'getItem' | 'setItem' | 'removeItem'
>

export function browserSessionStorage(): ConfigPendingStorage | null {
	try {
		return typeof window === 'undefined' ? null : window.sessionStorage
	} catch {
		return null
	}
}

export class ConfigRecoveryPersistenceError extends Error {
	constructor(readonly phase: 'mark' | 'settle' = 'mark') {
		super('Cannot retain the non-secret configuration write marker in this tab')
		this.name = 'ConfigRecoveryPersistenceError'
	}
}
