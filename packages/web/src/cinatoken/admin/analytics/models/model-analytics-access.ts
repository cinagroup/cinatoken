/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { configAccessIdentityKey } from '../../config/config-access-recovery'

type Domain = 'analytics' | 'display' | 'logs'
export class ModelAnalyticsAccessRecovery {
	private readonly denied: Record<Domain, Set<string>> = {
		analytics: new Set(),
		display: new Set(),
		logs: new Set(),
	}
	private readonly listeners = new Set<() => void>()
	getSnapshot = (key: string, domain: Domain): boolean =>
		this.denied[domain].has(key)
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}
	block(key: string, domain: Domain): boolean {
		const set = this.denied[domain]
		if (set.has(key)) return false
		set.add(key)
		while (set.size > 32) {
			const oldest = set.values().next().value
			if (oldest !== undefined) set.delete(oldest)
		}
		for (const listener of this.listeners) listener()
		return true
	}
	settle(key: string, domain: Domain): void {
		if (this.denied[domain].delete(key))
			for (const listener of this.listeners) listener()
	}
}
const stores = new WeakMap<object, ModelAnalyticsAccessRecovery>()
export function modelAnalyticsAccessRecovery(
	api: object
): ModelAnalyticsAccessRecovery {
	let store = stores.get(api)
	if (!store) {
		store = new ModelAnalyticsAccessRecovery()
		stores.set(api, store)
	}
	return store
}
export const modelAnalyticsAccessKey = configAccessIdentityKey
