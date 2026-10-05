/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { PendingConfigWrite } from './config-full-reconciliation'
import {
	browserSessionStorage,
	ConfigRecoveryPersistenceError,
	type ConfigPendingStorage,
} from './config-recovery-persistence'

export type ConfigPendingWrite = PendingConfigWrite

const storagePrefix = 'cinatoken.admin.config.pending.v1:'

function webhookChannelForKey(key: string): 'wecom' | 'feishu' | null {
	if (key.endsWith(':full:wecom')) return 'wecom'
	if (key.endsWith(':full:feishu')) return 'feishu'
	return null
}

function isWebhookWrite(
	pending: PendingConfigWrite
): pending is Extract<
	PendingConfigWrite,
	{ kind: 'webhook-replace' | 'webhook-clear' }
> {
	return pending.kind === 'webhook-replace' || pending.kind === 'webhook-clear'
}

/** Cross-reload webhook markers contain only identity, channel and action, never a URL. */
export class AdminConfigFullWriteRecovery {
	private readonly pending = new Map<string, ConfigPendingWrite>()
	private readonly listeners = new Set<() => void>()
	readonly maxScopes = 160
	constructor(
		private readonly storage: ConfigPendingStorage | null = browserSessionStorage(),
		private readonly requireWebhookStorage = typeof window !== 'undefined'
	) {}

	private storageKey(key: string): string {
		return storagePrefix + encodeURIComponent(key)
	}

	private persisted(
		key: string,
		phase: 'mark' | 'settle' = 'mark'
	): ConfigPendingWrite | null {
		const channel = webhookChannelForKey(key)
		if (!channel || !this.storage) return null
		let raw: string | null
		try {
			raw = this.storage.getItem(this.storageKey(key))
		} catch {
			throw new ConfigRecoveryPersistenceError(phase)
		}
		if (raw === null) return null
		try {
			const value: unknown = JSON.parse(raw)
			if (
				value &&
				typeof value === 'object' &&
				'kind' in value &&
				(value.kind === 'webhook-replace' || value.kind === 'webhook-clear') &&
				'channel' in value &&
				value.channel === channel &&
				'acknowledged' in value &&
				typeof value.acknowledged === 'boolean'
			)
				return {
					kind: value.kind,
					channel,
					acknowledged: value.acknowledged,
				}
		} catch {
			// An unreadable marker must not silently unlock a possibly completed write.
		}
		return { kind: 'webhook-replace', channel, acknowledged: false }
	}

	private persist(
		key: string,
		pending: ConfigPendingWrite,
		phase: 'mark' | 'settle' = 'mark'
	): void {
		if (!isWebhookWrite(pending)) return
		const channel = webhookChannelForKey(key)
		if (channel !== pending.channel && this.requireWebhookStorage)
			throw new ConfigRecoveryPersistenceError(phase)
		if (!this.storage) {
			if (this.requireWebhookStorage)
				throw new ConfigRecoveryPersistenceError(phase)
			return
		}
		try {
			this.storage.setItem(
				this.storageKey(key),
				JSON.stringify({
					kind: pending.kind,
					channel: pending.channel,
					acknowledged: pending.acknowledged,
				})
			)
		} catch {
			throw new ConfigRecoveryPersistenceError(phase)
		}
	}

	getSnapshot = (key: string): boolean => this.getPending(key) !== null
	getPending = (key: string): ConfigPendingWrite | null => {
		const memory = this.pending.get(key)
		if (memory) return memory
		try {
			const stored = this.persisted(key)
			if (stored) this.pending.set(key, stored)
			return stored
		} catch (error) {
			if (!(error instanceof ConfigRecoveryPersistenceError)) throw error
			const channel = webhookChannelForKey(key)
			return channel
				? { kind: 'webhook-replace', channel, acknowledged: false }
				: null
		}
	}
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}
	mark(key: string, pending: ConfigPendingWrite): void {
		this.persisted(key)
		this.persist(key, { ...pending, acknowledged: false })
		this.pending.delete(key)
		this.pending.set(key, { ...pending, acknowledged: false })
		while (this.pending.size > this.maxScopes) {
			const oldest = this.pending.keys().next().value
			if (oldest !== undefined) this.pending.delete(oldest)
		}
		this.notify()
	}
	acknowledge(key: string): void {
		const current = this.getPending(key)
		if (!current || current.acknowledged) return
		this.persisted(key, 'settle')
		this.persist(key, { ...current, acknowledged: true }, 'settle')
		this.pending.set(key, { ...current, acknowledged: true })
		this.notify()
	}
	settle(key: string): void {
		if (webhookChannelForKey(key) && this.storage) {
			this.persisted(key, 'settle')
			try {
				this.storage.removeItem(this.storageKey(key))
			} catch {
				throw new ConfigRecoveryPersistenceError('settle')
			}
		}
		if (this.pending.delete(key)) this.notify()
	}
	private notify(): void {
		for (const listener of this.listeners) listener()
	}
}

const stores = new WeakMap<object, AdminConfigFullWriteRecovery>()
export function adminConfigFullWriteRecovery(
	api: object
): AdminConfigFullWriteRecovery {
	let store = stores.get(api)
	if (!store) {
		store = new AdminConfigFullWriteRecovery()
		stores.set(api, store)
	}
	return store
}
