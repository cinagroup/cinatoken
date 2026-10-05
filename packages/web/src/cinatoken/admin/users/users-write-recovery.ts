/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	browserSessionStorage,
	type ConfigPendingStorage,
} from '../config/config-recovery-persistence'

const storagePrefix = 'cinatoken.admin.users.create.pending.v1:'
type KnownPostOutcome = 'confirmed-2xx' | 'definitive-rejection'

export class UsersWritePersistenceError extends Error {
	constructor() {
		super('Cannot retain the user creation marker in this tab')
		this.name = 'UsersWritePersistenceError'
	}
}

/** A cross-refresh marker contains only the stable Console identity, never user data. */
export class UsersWriteRecovery {
	private readonly pending = new Set<string>()
	private readonly listeners = new Set<() => void>()
	constructor(
		private readonly storage: ConfigPendingStorage | null = browserSessionStorage(),
		private readonly requireStorage = typeof window !== 'undefined'
	) {}

	private storageKey(key: string): string {
		return storagePrefix + encodeURIComponent(key)
	}

	getSnapshot = (key: string): boolean => {
		if (this.pending.has(key)) return true
		if (!this.requireStorage) return false
		if (!this.storage) return true
		try {
			return this.storage.getItem(this.storageKey(key)) !== null
		} catch {
			return true
		}
	}

	isStorageUnavailable(key: string): boolean {
		if (!this.requireStorage) return false
		if (!this.storage) return true
		try {
			this.storage.getItem(this.storageKey(key))
			return false
		} catch {
			return true
		}
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	/** Persist before dispatch; a failed write to storage prevents the POST. */
	markPending(key: string): void {
		if (this.getSnapshot(key) || !this.storage)
			throw new UsersWritePersistenceError()
		try {
			this.storage.setItem(this.storageKey(key), 'pending')
		} catch {
			throw new UsersWritePersistenceError()
		}
		this.pending.add(key)
		this.notify()
	}

	/** Only a known POST outcome may release the marker; a list GET is not evidence. */
	settleKnownPost(key: string, outcome: KnownPostOutcome): void {
		if (outcome !== 'confirmed-2xx' && outcome !== 'definitive-rejection')
			throw new Error('A user list response cannot resolve a creation outcome')
		if (this.requireStorage) {
			if (!this.storage) throw new UsersWritePersistenceError()
			try {
				this.storage.removeItem(this.storageKey(key))
			} catch {
				throw new UsersWritePersistenceError()
			}
		}
		this.pending.delete(key)
		this.notify()
	}

	private notify(): void {
		for (const listener of this.listeners) listener()
	}
}

const stores = new WeakMap<object, UsersWriteRecovery>()
export function usersWriteRecovery(api: object): UsersWriteRecovery {
	let store = stores.get(api)
	if (!store) {
		store = new UsersWriteRecovery()
		stores.set(api, store)
	}
	return store
}
