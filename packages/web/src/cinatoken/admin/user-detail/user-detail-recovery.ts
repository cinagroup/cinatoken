/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { configAccessIdentityKey } from '../config/config-access-recovery'
import {
	browserSessionStorage,
	type ConfigPendingStorage,
} from '../config/config-recovery-persistence'

export type UserDetailDomain =
	| 'user'
	| 'keys'
	| 'logs'
	| 'audits'
	| 'models'
	| 'display'
	| 'user-write'
	| 'key-write'

/** A denial is retained for the principal and permission domain, across remounts. */
export class UserDetailAccessRecovery {
	private readonly blocked = new Set<string>()
	private readonly listeners = new Set<() => void>()
	key(identity: string, domain: UserDetailDomain): string {
		return JSON.stringify([configAccessIdentityKey(identity), domain])
	}
	getSnapshot = (key: string): boolean => this.blocked.has(key)
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}
	block(key: string): boolean {
		if (this.blocked.has(key)) return false
		this.blocked.add(key)
		while (this.blocked.size > 64) {
			const oldest = this.blocked.values().next().value
			if (oldest) this.blocked.delete(oldest)
		}
		this.notify()
		return true
	}
	clear(key: string): void {
		if (this.blocked.delete(key)) this.notify()
	}
	private notify(): void {
		for (const listener of this.listeners) listener()
	}
}

const accessStores = new WeakMap<object, UserDetailAccessRecovery>()
export function userDetailAccessRecovery(
	api: object
): UserDetailAccessRecovery {
	let store = accessStores.get(api)
	if (!store) {
		store = new UserDetailAccessRecovery()
		accessStores.set(api, store)
	}
	return store
}

const keyCreatePrefix = 'cinatoken.admin.user-detail.key-create.pending.v1:'
export class KeyCreatePersistenceError extends Error {
	constructor() {
		super('Cannot retain the key creation marker in this tab')
		this.name = 'KeyCreatePersistenceError'
	}
}

/** No secret, name, metadata, or email is persisted. A read never resolves an uncertain POST. */
export class KeyCreateRecovery {
	private readonly listeners = new Set<() => void>()
	constructor(
		private readonly storage: ConfigPendingStorage | null = browserSessionStorage(),
		private readonly requireStorage = typeof window !== 'undefined'
	) {}
	private storageKey(identity: string, userId: string): string {
		return (
			keyCreatePrefix +
			encodeURIComponent(
				JSON.stringify([configAccessIdentityKey(identity), userId])
			)
		)
	}
	getSnapshot = (identity: string, userId: string): boolean => {
		if (!this.requireStorage) return false
		if (!this.storage) return true
		try {
			return this.storage.getItem(this.storageKey(identity, userId)) !== null
		} catch {
			return true
		}
	}
	isStorageUnavailable(identity: string, userId: string): boolean {
		if (!this.requireStorage) return false
		if (!this.storage) return true
		try {
			this.storage.getItem(this.storageKey(identity, userId))
			return false
		} catch {
			return true
		}
	}
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}
	markPending(identity: string, userId: string): void {
		if (this.getSnapshot(identity, userId) || !this.storage)
			throw new KeyCreatePersistenceError()
		try {
			this.storage.setItem(this.storageKey(identity, userId), 'pending')
		} catch {
			throw new KeyCreatePersistenceError()
		}
		this.notify()
	}
	settleKnownPost(identity: string, userId: string): void {
		if (this.requireStorage) {
			if (!this.storage) throw new KeyCreatePersistenceError()
			try {
				this.storage.removeItem(this.storageKey(identity, userId))
			} catch {
				throw new KeyCreatePersistenceError()
			}
		}
		this.notify()
	}
	private notify(): void {
		for (const listener of this.listeners) listener()
	}
}

const createStores = new WeakMap<object, KeyCreateRecovery>()
export function keyCreateRecovery(api: object): KeyCreateRecovery {
	let store = createStores.get(api)
	if (!store) {
		store = new KeyCreateRecovery()
		createStores.set(api, store)
	}
	return store
}
