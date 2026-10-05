/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
/** A 401/403 keeps this page closed across Console rechecks and remounts. */
export class AdminConfigAccessRecovery {
	private readonly blocked = new Set<string>()
	private readonly listeners = new Set<() => void>()
	readonly maxScopes = 32

	getSnapshot = (key: string): boolean => this.blocked.has(key)

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	/** Only the first denial per identity should initiate a Console recheck. */
	block(key: string): boolean {
		if (this.blocked.has(key)) return false
		this.blocked.add(key)
		while (this.blocked.size > this.maxScopes) {
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

/** Portal scopeVersion advances during access revalidation; the denied principal does not. */
export function configAccessIdentityKey(reconciliationKey: string): string {
	try {
		const identity: unknown = JSON.parse(reconciliationKey)
		if (
			Array.isArray(identity) &&
			identity.length === 3 &&
			typeof identity[0] === 'string' &&
			identity[0].length > 0 &&
			typeof identity[1] === 'string' &&
			identity[1].length > 0 &&
			Number.isSafeInteger(identity[2])
		)
			return JSON.stringify([identity[0], identity[1]])
	} catch {
		// Caller-supplied keys outside the route integration retain their own identity.
	}
	return reconciliationKey
}

const stores = new WeakMap<object, AdminConfigAccessRecovery>()
export function adminConfigAccessRecovery(
	api: object
): AdminConfigAccessRecovery {
	let store = stores.get(api)
	if (!store) {
		store = new AdminConfigAccessRecovery()
		stores.set(api, store)
	}
	return store
}
