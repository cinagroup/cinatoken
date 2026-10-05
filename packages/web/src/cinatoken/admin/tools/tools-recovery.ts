/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { AccessKeyAccessRecovery } from '../access-keys/access-key-recovery'
import { configAccessIdentityKey } from '../config/config-access-recovery'
import {
	browserSessionStorage,
	type ConfigPendingStorage,
} from '../config/config-recovery-persistence'
import { ToolPersistenceError } from './tools-errors'
import {
	parseToolJournal,
	parseToolMarker,
	toolMarkerSchema,
	type ToolMarker,
	type ToolMarkerInput,
} from './tools-marker'

/** Session-local durable uncertainty; no claim of cross-tab storage atomicity. */
export class ToolWriteRecovery {
	private readonly listeners = new Set<() => void>()
	private readonly unavailable = new Set<string>()
	constructor(
		private readonly storage: ConfigPendingStorage | null = browserSessionStorage(),
		private readonly requireStorage = typeof window !== 'undefined'
	) {}
	private key(identity: string, version = 2): string {
		return (
			`cinatoken.admin.tools.pending.v${version}:` +
			encodeURIComponent(configAccessIdentityKey(identity))
		)
	}
	private journalKey(identity: string): string {
		return this.key(identity).replace('.pending.v2:', '.journal.v1:')
	}
	private read(identity: string) {
		if (!this.storage) throw new ToolPersistenceError()
		return {
			legacy: this.storage.getItem(this.key(identity, 1)),
			pending: this.storage.getItem(this.key(identity)),
			journal: this.storage.getItem(this.journalKey(identity)),
		}
	}
	status(identity: string): 'ready' | 'pending' | 'unavailable' {
		if (this.unavailable.has(this.key(identity))) return 'unavailable'
		if (!this.requireStorage) return 'ready'
		try {
			const state = this.read(identity)
			if (state.legacy !== null || state.pending !== null) return 'pending'
			if (state.journal === null) return 'ready'
			return parseToolJournal(state.journal)?.phase === 'cleared'
				? 'ready'
				: 'pending'
		} catch {
			return 'unavailable'
		}
	}
	marker(identity: string): ToolMarker | null {
		if (this.status(identity) !== 'pending') return null
		try {
			const state = this.read(identity)
			if (state.legacy !== null) return null
			const journal = parseToolJournal(state.journal)
			const pending = parseToolMarker(state.pending)
			if (
				(state.journal !== null && !journal) ||
				(state.pending !== null && !pending)
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
			return journal && journal.phase !== 'cleared' ? journal.marker : null
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
	markPending(identity: string, input: ToolMarkerInput): ToolMarker {
		if (this.status(identity) !== 'ready' || !this.storage)
			throw new ToolPersistenceError()
		try {
			const marker = toolMarkerSchema.parse({
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
				throw new ToolPersistenceError()
			this.storage.setItem(this.key(identity), raw)
			state = this.read(identity)
			if (
				state.pending !== raw ||
				state.journal !== journal ||
				state.legacy !== null
			)
				throw new ToolPersistenceError()
			this.notify()
			return Object.freeze(marker)
		} catch {
			this.unavailable.add(this.key(identity))
			this.notify()
			throw new ToolPersistenceError()
		}
	}
	/** Compare/write/remove/readback is synchronous, with a durable clearing journal. */
	private removeMatching(identity: string, marker: ToolMarker): void {
		const parsed = toolMarkerSchema.safeParse(marker)
		if (!parsed.success || !this.storage || this.status(identity) !== 'pending')
			throw new ToolPersistenceError()
		const raw = JSON.stringify(parsed.data)
		if (JSON.stringify(this.marker(identity)) !== raw)
			throw new ToolPersistenceError()
		try {
			const clearing = JSON.stringify({
				version: 1,
				phase: 'clearing',
				marker: parsed.data,
			})
			this.storage.setItem(this.journalKey(identity), clearing)
			let state = this.read(identity)
			if (
				state.journal !== clearing ||
				state.legacy !== null ||
				(state.pending !== null && state.pending !== raw)
			)
				throw new ToolPersistenceError()
			if (state.pending !== null) this.storage.removeItem(this.key(identity))
			state = this.read(identity)
			if (
				state.pending !== null ||
				state.legacy !== null ||
				state.journal !== clearing
			)
				throw new ToolPersistenceError()
			const cleared = JSON.stringify({
				version: 1,
				phase: 'cleared',
				marker: parsed.data,
			})
			this.storage.setItem(this.journalKey(identity), cleared)
			state = this.read(identity)
			if (
				state.pending !== null ||
				state.legacy !== null ||
				state.journal !== cleared
			)
				throw new ToolPersistenceError()
		} catch {
			this.unavailable.add(this.key(identity))
			this.notify()
			throw new ToolPersistenceError()
		}
		this.notify()
	}
	settleKnown(
		identity: string,
		outcome: 'confirmed-2xx' | 'definitive-rejection',
		marker: ToolMarker
	): void {
		if (!['confirmed-2xx', 'definitive-rejection'].includes(outcome))
			throw new ToolPersistenceError()
		this.removeMatching(identity, marker)
	}
	acknowledgeUnknown(identity: string, marker: ToolMarker): void {
		this.removeMatching(identity, marker)
	}
}
const stores = new WeakMap<object, ReturnType<typeof createStores>>()
function createStores() {
	return {
		write: new ToolWriteRecovery(),
		read: new AccessKeyAccessRecovery(),
		writeAccess: new AccessKeyAccessRecovery(),
		revealAccess: new AccessKeyAccessRecovery(),
		auditAccess: new AccessKeyAccessRecovery(),
	}
}
export function toolRecovery(api: object) {
	let state = stores.get(api)
	if (!state) {
		state = createStores()
		stores.set(api, state)
	}
	return state
}
