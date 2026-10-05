/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { AccessKeyAccessRecovery } from '../access-keys/access-key-recovery'
import { configAccessIdentityKey } from '../config/config-access-recovery'
import {
	browserSessionStorage,
	type ConfigPendingStorage,
} from '../config/config-recovery-persistence'
import { AdminSharedKeyPersistenceError } from './shared-key-errors'
import {
	adminSharedKeyMarkerSchema,
	parseSharedKeyMarker,
	parseSharedKeyJournal,
	type AdminSharedKeyMarker,
	type AdminSharedKeyMarkerInput,
} from './shared-key-marker'

export class AdminSharedKeyWriteRecovery {
	private readonly listeners = new Set<() => void>()
	private readonly unavailable = new Set<string>()
	constructor(
		private readonly operation: 'governance' | 'review',
		private readonly storage: ConfigPendingStorage | null = browserSessionStorage(),
		private readonly requireStorage = typeof window !== 'undefined'
	) {}
	private key(identity: string, version = 2): string {
		return (
			`cinatoken.admin.shared-keys.${this.operation}.pending.v${version}:` +
			encodeURIComponent(configAccessIdentityKey(identity))
		)
	}
	private journalKey(identity: string): string {
		return this.key(identity).replace('.pending.v2:', '.journal.v1:')
	}
	private read(identity: string) {
		if (!this.storage) throw new AdminSharedKeyPersistenceError()
		return {
			legacy: this.storage.getItem(this.key(identity, 1)),
			pending: this.storage.getItem(this.key(identity)),
			journal: this.storage.getItem(this.journalKey(identity)),
		}
	}
	status(identity: string): 'ready' | 'pending' | 'unavailable' {
		if (this.unavailable.has(this.key(identity))) return 'unavailable'
		if (!this.requireStorage) return 'ready'
		if (!this.storage) return 'unavailable'
		try {
			const state = this.read(identity)
			if (state.legacy !== null || state.pending !== null) return 'pending'
			if (state.journal === null) return 'ready'
			const journal = parseSharedKeyJournal(state.journal)
			return journal?.marker.kind === this.operation &&
				journal.phase === 'cleared'
				? 'ready'
				: 'pending'
		} catch {
			return 'unavailable'
		}
	}
	marker(identity: string): AdminSharedKeyMarker | null {
		if (this.status(identity) !== 'pending' || !this.storage) return null
		try {
			const state = this.read(identity)
			if (state.legacy !== null) return null
			const journal = parseSharedKeyJournal(state.journal)
			if (
				state.journal !== null &&
				(!journal || journal.marker.kind !== this.operation)
			)
				return null
			const pending = parseSharedKeyMarker(state.pending)
			if (
				state.pending !== null &&
				(!pending || pending.kind !== this.operation)
			)
				return null
			if (pending) {
				if (
					journal &&
					journal.phase !== 'cleared' &&
					JSON.stringify(journal.marker) !== state.pending
				)
					return null
				return pending
			}
			if (journal && journal.phase !== 'cleared') return journal.marker
			return null
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
	private notify(): void {
		this.listeners.forEach((listener) => listener())
	}
	markPending(
		identity: string,
		input: AdminSharedKeyMarkerInput
	): AdminSharedKeyMarker {
		if (
			this.status(identity) !== 'ready' ||
			!this.storage ||
			input.kind !== this.operation
		)
			throw new AdminSharedKeyPersistenceError()
		try {
			const marker = adminSharedKeyMarkerSchema.parse({
				...input,
				version: 2,
				generation: crypto.randomUUID(),
			})
			const raw = JSON.stringify(marker)
			const journal = JSON.stringify({ version: 1, phase: 'pending', marker })
			this.storage.setItem(this.journalKey(identity), journal)
			let state = this.read(identity)
			if (
				state.journal !== journal ||
				state.pending !== null ||
				state.legacy !== null
			)
				throw new AdminSharedKeyPersistenceError()
			this.storage.setItem(this.key(identity), raw)
			state = this.read(identity)
			if (
				state.pending !== raw ||
				state.journal !== journal ||
				state.legacy !== null
			)
				throw new AdminSharedKeyPersistenceError()
			this.notify()
			return Object.freeze(marker)
		} catch {
			this.unavailable.add(this.key(identity))
			this.notify()
			throw new AdminSharedKeyPersistenceError()
		}
	}
	/** No asynchronous work belongs between the compare, remove, and readback. */
	private removeMatching(identity: string, marker: AdminSharedKeyMarker): void {
		const checked = adminSharedKeyMarkerSchema.safeParse(marker)
		if (
			!checked.success ||
			checked.data.kind !== this.operation ||
			!this.storage ||
			this.status(identity) !== 'pending'
		)
			throw new AdminSharedKeyPersistenceError()
		const raw = JSON.stringify(checked.data)
		// A different generation belongs to another operation and must be preserved.
		if (JSON.stringify(this.marker(identity)) !== raw)
			throw new AdminSharedKeyPersistenceError()
		try {
			const clearing = JSON.stringify({
				version: 1,
				phase: 'clearing',
				marker: checked.data,
			})
			this.storage.setItem(this.journalKey(identity), clearing)
			let state = this.read(identity)
			if (
				state.journal !== clearing ||
				state.legacy !== null ||
				(state.pending !== null && state.pending !== raw)
			)
				throw new AdminSharedKeyPersistenceError()
			if (state.pending !== null) this.storage.removeItem(this.key(identity))
			state = this.read(identity)
			if (
				state.pending !== null ||
				state.legacy !== null ||
				state.journal !== clearing
			)
				throw new AdminSharedKeyPersistenceError()
			// Keep a durable terminal receipt. It permits a NEW review, not a replay or a claim about an unknown result.
			const cleared = JSON.stringify({
				version: 1,
				phase: 'cleared',
				marker: checked.data,
			})
			this.storage.setItem(this.journalKey(identity), cleared)
			state = this.read(identity)
			if (
				state.pending !== null ||
				state.legacy !== null ||
				state.journal !== cleared
			)
				throw new AdminSharedKeyPersistenceError()
		} catch {
			this.unavailable.add(this.key(identity))
			this.notify()
			throw new AdminSharedKeyPersistenceError()
		}
		this.notify()
	}
	settleKnown(
		identity: string,
		outcome: 'confirmed-2xx' | 'definitive-rejection',
		marker: AdminSharedKeyMarker
	): void {
		if (!['confirmed-2xx', 'definitive-rejection'].includes(outcome))
			throw new AdminSharedKeyPersistenceError()
		this.removeMatching(identity, marker)
	}
	acknowledgeUnknown(identity: string, marker: AdminSharedKeyMarker): void {
		this.removeMatching(identity, marker)
	}
}
function createStores() {
	return {
		write: new AdminSharedKeyWriteRecovery('governance'),
		reviewWrite: new AdminSharedKeyWriteRecovery('review'),
		read: new AccessKeyAccessRecovery(),
		writeAccess: new AccessKeyAccessRecovery(),
		auditAccess: new AccessKeyAccessRecovery(),
		reviewAccess: new AccessKeyAccessRecovery(),
	}
}
const stores = new WeakMap<object, ReturnType<typeof createStores>>()
export function adminSharedKeyRecovery(api: object) {
	let value = stores.get(api)
	if (!value) {
		value = createStores()
		stores.set(api, value)
	}
	return value
}
