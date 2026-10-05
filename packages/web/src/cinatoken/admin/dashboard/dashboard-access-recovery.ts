/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { configAccessIdentityKey } from '../config/config-access-recovery'

/** A denied dashboard remains closed through Console rechecks and route remounts. */
export class DashboardAccessRecovery {
	private readonly blocked = new Set<string>()
	private readonly listeners = new Set<() => void>()
	readonly maxIdentities = 32

	getSnapshot = (key: string): boolean => this.blocked.has(key)

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	block(key: string): boolean {
		if (this.blocked.has(key)) return false
		this.blocked.add(key)
		while (this.blocked.size > this.maxIdentities) {
			const oldest = this.blocked.values().next().value
			if (oldest !== undefined) this.blocked.delete(oldest)
		}
		this.notify()
		return true
	}

	settle(key: string): void {
		if (this.blocked.delete(key)) this.notify()
	}

	private notify(): void {
		for (const listener of this.listeners) listener()
	}
}

const stores = new WeakMap<object, DashboardAccessRecovery>()
export function dashboardAccessRecovery(api: object): DashboardAccessRecovery {
	let store = stores.get(api)
	if (!store) {
		store = new DashboardAccessRecovery()
		stores.set(api, store)
	}
	return store
}

export const dashboardAccessIdentityKey = configAccessIdentityKey
