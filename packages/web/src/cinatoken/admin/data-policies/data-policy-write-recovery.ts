/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
/** Only a target ID is retained. Form input, response, and error bodies never enter this store. */
export class DataPolicyWriteRecovery {
	private readonly pending = new Map<string, string>()
	private readonly listeners = new Set<() => void>()
	readonly maxScopes = 32

	getSnapshot(key: string): boolean {
		return this.pending.has(key)
	}

	getTarget(key: string): string | null {
		return this.pending.get(key) ?? null
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	mark(key: string, targetId: string): void {
		this.pending.delete(key)
		this.pending.set(key, targetId)
		while (this.pending.size > this.maxScopes) {
			const oldest = this.pending.keys().next().value
			if (oldest !== undefined) this.pending.delete(oldest)
		}
		this.notify()
	}

	settle(key: string): void {
		if (this.pending.delete(key)) this.notify()
	}

	async reconcile(
		key: string,
		read: (targetId: string) => Promise<boolean>,
		isCurrent: () => boolean
	): Promise<boolean> {
		const targetId = this.getTarget(key)
		if (targetId === null) return false
		if (!(await read(targetId)) || !isCurrent()) return false
		this.settle(key)
		return true
	}

	private notify(): void {
		for (const listener of this.listeners) listener()
	}
}

const stores = new WeakMap<object, DataPolicyWriteRecovery>()
export function dataPolicyWriteRecovery(api: object): DataPolicyWriteRecovery {
	let store = stores.get(api)
	if (!store) {
		store = new DataPolicyWriteRecovery()
		stores.set(api, store)
	}
	return store
}
