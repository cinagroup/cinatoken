/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { configAccessIdentityKey } from '../config/config-access-recovery'
import {
	browserSessionStorage,
	type ConfigPendingStorage,
} from '../config/config-recovery-persistence'

const prefix = 'cinatoken.admin.user-factors.pending.v1:'
export class UserFactorRecovery {
	private listeners = new Set<() => void>()
	private unavailable = new Set<string>()
	constructor(
		private storage: ConfigPendingStorage | null = browserSessionStorage()
	) {}
	private key(identity: string, userId: string) {
		return (
			prefix +
			encodeURIComponent(
				JSON.stringify([configAccessIdentityKey(identity), userId])
			)
		)
	}
	status(
		identity: string,
		userId: string
	): 'ready' | 'pending' | 'unavailable' {
		const key = this.key(identity, userId)
		if (!this.storage || this.unavailable.has(key)) return 'unavailable'
		try {
			return this.storage.getItem(key) === null ? 'ready' : 'pending'
		} catch {
			return 'unavailable'
		}
	}
	marker(identity: string, userId: string): string | null {
		try {
			const raw = this.storage?.getItem(this.key(identity, userId))
			return raw && /^[0-9a-f-]{36}$/u.test(raw) ? raw : null
		} catch {
			return null
		}
	}
	subscribe = (listener: () => void) => {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}
	private notify() {
		this.listeners.forEach((listener) => listener())
	}
	mark(identity: string, userId: string): string {
		const key = this.key(identity, userId)
		if (this.status(identity, userId) !== 'ready' || !this.storage)
			throw new Error('Factor write safety unavailable')
		const generation = crypto.randomUUID()
		try {
			this.storage.setItem(key, generation)
			if (this.storage.getItem(key) !== generation)
				throw new Error('Marker missing')
			this.notify()
			return generation
		} catch {
			this.unavailable.add(key)
			this.notify()
			throw new Error('Factor write safety unavailable')
		}
	}
	settle(identity: string, userId: string, generation: string) {
		const key = this.key(identity, userId)
		if (!this.storage || this.marker(identity, userId) !== generation)
			throw new Error('Factor marker changed')
		try {
			this.storage.removeItem(key)
			if (this.storage.getItem(key) !== null) throw new Error('Marker retained')
			this.notify()
		} catch {
			try {
				if (this.storage.getItem(key) === null)
					this.storage.setItem(key, generation)
			} catch {
				/* Retain an unavailable state in this instance. */
			}
			this.unavailable.add(key)
			this.notify()
			throw new Error('Factor marker could not be released')
		}
	}
}
let browserStore: UserFactorRecovery | undefined
export function userFactorRecovery() {
	return (browserStore ??= new UserFactorRecovery())
}
