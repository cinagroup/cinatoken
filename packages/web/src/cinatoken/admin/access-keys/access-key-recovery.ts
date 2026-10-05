/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { configAccessIdentityKey } from '../config/config-access-recovery'
import {
	browserSessionStorage,
	type ConfigPendingStorage,
} from '../config/config-recovery-persistence'

const pendingPrefix = 'cinatoken.admin.access-keys.write.pending.v1:'

export class AccessKeyWritePersistenceError extends Error {
	constructor() {
		super('Cannot retain integration key write safety marker in this tab')
		this.name = 'AccessKeyWritePersistenceError'
	}
}

/** The marker has no secret or request body and survives reloads for this principal. */
export class AccessKeyWriteRecovery {
	private readonly listeners = new Set<() => void>()
	constructor(
		private readonly storage: ConfigPendingStorage | null = browserSessionStorage(),
		private readonly requireStorage = typeof window !== 'undefined'
	) {}
	private key(identity: string): string {
		return pendingPrefix + encodeURIComponent(configAccessIdentityKey(identity))
	}
	status(identity: string): 'ready' | 'pending' | 'unavailable' {
		if (!this.requireStorage) return 'ready'
		if (!this.storage) return 'unavailable'
		try {
			return this.storage.getItem(this.key(identity)) === null
				? 'ready'
				: 'pending'
		} catch {
			return 'unavailable'
		}
	}
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}
	markPending(identity: string): void {
		if (this.status(identity) !== 'ready' || !this.storage)
			throw new AccessKeyWritePersistenceError()
		try {
			this.storage.setItem(this.key(identity), 'pending')
		} catch {
			throw new AccessKeyWritePersistenceError()
		}
		this.notify()
	}
	settleKnown(identity: string): void {
		if (this.requireStorage) {
			if (!this.storage) throw new AccessKeyWritePersistenceError()
			try {
				this.storage.removeItem(this.key(identity))
			} catch {
				throw new AccessKeyWritePersistenceError()
			}
		}
		this.notify()
	}
	private notify(): void {
		for (const listener of this.listeners) listener()
	}
}

export class AccessKeyAccessRecovery {
	private readonly blocked = new Set<string>()
	private readonly listeners = new Set<() => void>()
	key(identity: string): string {
		return configAccessIdentityKey(identity)
	}
	getSnapshot = (identity: string): boolean =>
		this.blocked.has(this.key(identity))
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}
	block(identity: string): boolean {
		const key = this.key(identity)
		if (this.blocked.has(key)) return false
		this.blocked.add(key)
		while (this.blocked.size > 32) {
			const oldest = this.blocked.values().next().value
			if (oldest !== undefined) this.blocked.delete(oldest)
		}
		for (const listener of this.listeners) listener()
		return true
	}
}

const writeStores = new WeakMap<object, AccessKeyWriteRecovery>()
const accessStores = new WeakMap<object, AccessKeyAccessRecovery>()
export function accessKeyWriteRecovery(api: object): AccessKeyWriteRecovery {
	let store = writeStores.get(api)
	if (!store) {
		store = new AccessKeyWriteRecovery()
		writeStores.set(api, store)
	}
	return store
}
export function accessKeyAccessRecovery(api: object): AccessKeyAccessRecovery {
	let store = accessStores.get(api)
	if (!store) {
		store = new AccessKeyAccessRecovery()
		accessStores.set(api, store)
	}
	return store
}
