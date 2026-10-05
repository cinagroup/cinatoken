/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { configAccessIdentityKey } from '../config/config-access-recovery'

type Domain = 'analytics' | 'display'

/** A denied read stays blocked across Console rechecks and route remounts. */
export class ReliabilityAccessRecovery {
	private readonly blocked = {
		analytics: new Set<string>(),
		display: new Set<string>(),
	}
	private readonly listeners = new Set<() => void>()
	readonly maxIdentities = 32

	getSnapshot = (key: string, domain: Domain): boolean =>
		this.blocked[domain].has(key)

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	block(key: string, domain: Domain): boolean {
		const set = this.blocked[domain]
		if (set.has(key)) return false
		set.add(key)
		while (set.size > this.maxIdentities) {
			const oldest = set.values().next().value
			if (oldest !== undefined) set.delete(oldest)
		}
		this.notify()
		return true
	}

	settle(key: string, domain: Domain): void {
		if (this.blocked[domain].delete(key)) this.notify()
	}

	private notify(): void {
		for (const listener of this.listeners) listener()
	}
}

const stores = new WeakMap<object, ReliabilityAccessRecovery>()
export function reliabilityAccessRecovery(
	api: object
): ReliabilityAccessRecovery {
	let store = stores.get(api)
	if (!store) {
		store = new ReliabilityAccessRecovery()
		stores.set(api, store)
	}
	return store
}

export const reliabilityAccessIdentityKey = configAccessIdentityKey
