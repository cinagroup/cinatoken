/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { PendingConfigWrite } from './config-full-reconciliation'
import {
	browserSessionStorage,
	ConfigRecoveryPersistenceError,
	type ConfigPendingStorage,
} from './config-recovery-persistence'

const storagePrefix = 'cinatoken.admin.config.timezone-pending.v1:'

/** Shared by both config views, including full navigations to a fresh JS realm. */
export class AdminConfigWriteRecovery {
	private readonly pending = new Map<string, PendingConfigWrite | null>()
	private readonly listeners = new Set<() => void>()
	readonly maxScopes = 32
	constructor(
		private readonly storage: ConfigPendingStorage | null = browserSessionStorage(),
		private readonly requireStorage = typeof window !== 'undefined'
	) {}

	private storageKey(key: string): string {
		return storagePrefix + encodeURIComponent(key)
	}

	private persisted(key: string, phase: 'mark' | 'settle' = 'mark'): boolean {
		if (!this.storage) return false
		try {
			return this.storage.getItem(this.storageKey(key)) !== null
		} catch {
			throw new ConfigRecoveryPersistenceError(phase)
		}
	}

	getSnapshot = (key: string): boolean => {
		if (this.pending.has(key)) return true
		try {
			return this.persisted(key)
		} catch (error) {
			if (!(error instanceof ConfigRecoveryPersistenceError)) throw error
			return true
		}
	}
	getPending = (key: string): PendingConfigWrite | null => {
		if (this.pending.has(key)) return this.pending.get(key) ?? null
		try {
			if (this.persisted(key)) this.pending.set(key, null)
		} catch (error) {
			if (!(error instanceof ConfigRecoveryPersistenceError)) throw error
		}
		return null
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	mark(key: string, value: PendingConfigWrite | null = null): void {
		this.persisted(key)
		if (!this.storage) {
			if (this.requireStorage) throw new ConfigRecoveryPersistenceError()
		} else {
			try {
				this.storage.setItem(this.storageKey(key), 'pending')
			} catch {
				throw new ConfigRecoveryPersistenceError()
			}
		}
		this.pending.delete(key)
		this.pending.set(key, value)
		while (this.pending.size > this.maxScopes) {
			const oldest = this.pending.keys().next().value
			if (oldest !== undefined) this.pending.delete(oldest)
		}
		this.notify()
	}

	settle(key: string): void {
		const wasPending = this.getSnapshot(key)
		if (this.storage) {
			this.persisted(key, 'settle')
			try {
				this.storage.removeItem(this.storageKey(key))
			} catch {
				throw new ConfigRecoveryPersistenceError('settle')
			}
		}
		this.pending.delete(key)
		if (wasPending) this.notify()
	}

	private notify(): void {
		for (const listener of this.listeners) listener()
	}
}

const stores = new WeakMap<object, AdminConfigWriteRecovery>()
export function adminConfigWriteRecovery(
	api: object
): AdminConfigWriteRecovery {
	let store = stores.get(api)
	if (!store) {
		store = new AdminConfigWriteRecovery()
		stores.set(api, store)
	}
	return store
}
