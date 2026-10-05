/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import {
	AdminConfigAccessRecovery,
	configAccessIdentityKey,
} from '../config/config-access-recovery'
import {
	browserSessionStorage,
	type ConfigPendingStorage,
} from '../config/config-recovery-persistence'
import { ChainOperationError } from './chain-operations-errors'
import type { ChainOperationKind } from './types'

const markerSchema = z
	.object({
		version: z.literal(1),
		generation: z.string().uuid(),
		operation: z.enum(['process', 'reject']),
	})
	.strict()
export type ChainPendingMarker = z.infer<typeof markerSchema>

/** Queue delivery and refunds cannot be inferred from a list GET or an HTTP abort. */
export class ChainOperationWriteRecovery {
	private readonly unavailable = new Set<string>()
	private readonly listeners = new Set<() => void>()
	constructor(
		private readonly storage: ConfigPendingStorage | null = browserSessionStorage(),
		private readonly requireStorage = typeof window !== 'undefined'
	) {}
	private key(identity: string, kind: ChainOperationKind): string {
		return (
			'cinatoken.admin.chain-operations.pending.v1:' +
			kind +
			':' +
			encodeURIComponent(configAccessIdentityKey(identity))
		)
	}
	status(
		identity: string,
		kind: ChainOperationKind
	): 'ready' | 'pending' | 'unavailable' {
		const key = this.key(identity, kind)
		if (this.unavailable.has(key)) return 'unavailable'
		if (!this.requireStorage && !this.storage) return 'ready'
		if (!this.storage) return 'unavailable'
		try {
			return this.storage.getItem(key) === null ? 'ready' : 'pending'
		} catch {
			return 'unavailable'
		}
	}
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}
	private notify(): void {
		this.listeners.forEach((listener) => listener())
	}
	marker(
		identity: string,
		kind: ChainOperationKind
	): ChainPendingMarker | null {
		if (this.status(identity, kind) !== 'pending' || !this.storage) return null
		try {
			const raw = this.storage.getItem(this.key(identity, kind))
			if (raw === null) return null
			const parsed = markerSchema.safeParse(JSON.parse(raw) as unknown)
			return parsed.success ? parsed.data : null
		} catch {
			return null
		}
	}
	markPending(
		identity: string,
		kind: ChainOperationKind,
		operation: ChainPendingMarker['operation']
	): ChainPendingMarker {
		if (this.status(identity, kind) !== 'ready' || !this.storage)
			throw new ChainOperationError('storage')
		try {
			const marker = markerSchema.parse({
				version: 1,
				generation: crypto.randomUUID(),
				operation,
			})
			const raw = JSON.stringify(marker)
			this.storage.setItem(this.key(identity, kind), raw)
			if (this.storage.getItem(this.key(identity, kind)) !== raw)
				throw new Error('Pending marker was not retained')
			this.notify()
			return marker
		} catch {
			this.unavailable.add(this.key(identity, kind))
			this.notify()
			throw new ChainOperationError('storage')
		}
	}
	settleKnown(
		identity: string,
		kind: ChainOperationKind,
		marker: ChainPendingMarker,
		outcome: 'confirmed-2xx' | 'definitive-rejection'
	): void {
		if (!['confirmed-2xx', 'definitive-rejection'].includes(outcome))
			throw new ChainOperationError('storage')
		this.clearMatching(identity, kind, marker)
	}
	/** The caller explicitly accepts the unresolved result; this is not evidence of success. */
	acknowledgeUnknown(
		identity: string,
		kind: ChainOperationKind,
		marker: ChainPendingMarker
	): void {
		this.clearMatching(identity, kind, marker)
	}
	private clearMatching(
		identity: string,
		kind: ChainOperationKind,
		marker: ChainPendingMarker
	): void {
		if (!this.storage) throw new ChainOperationError('storage')
		try {
			const raw = JSON.stringify(markerSchema.parse(marker))
			if (this.storage.getItem(this.key(identity, kind)) !== raw)
				throw new Error('Another operation owns this marker')
			this.storage.removeItem(this.key(identity, kind))
			if (this.storage.getItem(this.key(identity, kind)) !== null)
				throw new Error('Marker could not be cleared')
			this.notify()
		} catch {
			this.unavailable.add(this.key(identity, kind))
			this.notify()
			throw new ChainOperationError('storage')
		}
	}
}
function createRecovery() {
	return {
		write: new ChainOperationWriteRecovery(),
		read: new AdminConfigAccessRecovery(),
		writeAccess: new AdminConfigAccessRecovery(),
	}
}
const stores = new WeakMap<object, ReturnType<typeof createRecovery>>()
export function chainOperationRecovery(api: object) {
	let recovery = stores.get(api)
	if (!recovery) {
		recovery = createRecovery()
		stores.set(api, recovery)
	}
	return recovery
}
