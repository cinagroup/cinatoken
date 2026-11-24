/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import { configAccessIdentityKey } from './config-access-recovery'
import {
	configRevisionSchema,
	streamTimeoutMsConfigurationSchema,
	streamTimeoutGroupsConfigurationSchema,
	type AdminConfigRevision,
	type StreamTimeoutConfiguration,
} from './config-contracts'
import {
	browserSessionStorage,
	ConfigRecoveryPersistenceError,
	type ConfigPendingStorage,
} from './config-recovery-persistence'
import {
	normalizeStreamTimeout,
	streamTimeoutFieldSchema,
	type StreamTimeoutField,
} from './config-stream-timeout'

const markerSchema = z
	.object({
		version: z.literal(1),
		generation: z.string().uuid(),
		field: streamTimeoutFieldSchema,
		value: z.string(),
		expectedRevision: configRevisionSchema.nullable(),
	})
	.strict()
	.refine((marker) => {
		try {
			return normalizeStreamTimeout(marker.field, marker.value) === marker.value
		} catch {
			return false
		}
	})
export type StreamTimeoutMarker = z.infer<typeof markerSchema>
export function reconcileStreamTimeout(
	marker: StreamTimeoutMarker,
	field: StreamTimeoutConfiguration | undefined
): 'unknown' | 'matches' | 'differs' {
	const schema =
		marker.field === 'streamFirstEventTimeoutMs'
			? streamTimeoutMsConfigurationSchema
			: streamTimeoutGroupsConfigurationSchema
	if (
		!field ||
		!schema.safeParse(field).success ||
		!field.revision ||
		field.revision.toLowerCase() === 'legacy' ||
		field.revision.toLowerCase() === marker.expectedRevision?.toLowerCase()
	)
		return 'unknown'
	// A new row revision fences out this old compare-and-set, even if its request is still in flight.
	return field.value === marker.value ? 'matches' : 'differs'
}
export class StreamTimeoutRecovery {
	private readonly listeners = new Set<() => void>()
	private readonly unavailable = new Set<string>()
	constructor(
		private readonly storage: ConfigPendingStorage | null = browserSessionStorage()
	) {}
	private key(identity: string, field: StreamTimeoutField) {
		return (
			'cinatoken.admin.stream-timeout.pending.v1:' +
			encodeURIComponent(
				JSON.stringify([configAccessIdentityKey(identity), field])
			)
		)
	}
	status(
		identity: string,
		field: StreamTimeoutField
	): 'ready' | 'pending' | 'unavailable' {
		const key = this.key(identity, field)
		if (!this.storage || this.unavailable.has(key)) return 'unavailable'
		try {
			return this.storage.getItem(key) === null ? 'ready' : 'pending'
		} catch {
			return 'unavailable'
		}
	}
	marker(
		identity: string,
		field: StreamTimeoutField
	): StreamTimeoutMarker | null {
		try {
			const raw = this.storage?.getItem(this.key(identity, field))
			if (!raw) return null
			const parsed = markerSchema.safeParse(JSON.parse(raw) as unknown)
			return parsed.success && parsed.data.field === field ? parsed.data : null
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
	mark(
		identity: string,
		field: StreamTimeoutField,
		value: string,
		expectedRevision: AdminConfigRevision
	): StreamTimeoutMarker {
		if (!this.storage || this.status(identity, field) !== 'ready')
			throw new ConfigRecoveryPersistenceError('mark')
		const key = this.key(identity, field)
		try {
			const marker = markerSchema.parse({
				version: 1,
				generation: crypto.randomUUID(),
				field,
				value,
				expectedRevision,
			})
			const raw = JSON.stringify(marker)
			this.storage.setItem(key, raw)
			if (this.storage.getItem(key) !== raw)
				throw new Error('Marker unavailable')
			this.notify()
			return marker
		} catch {
			this.unavailable.add(key)
			this.notify()
			throw new ConfigRecoveryPersistenceError('mark')
		}
	}
	settle(identity: string, marker: StreamTimeoutMarker) {
		const key = this.key(identity, marker.field)
		const current = this.marker(identity, marker.field)
		if (
			!this.storage ||
			!current ||
			JSON.stringify(current) !== JSON.stringify(marker)
		)
			throw new ConfigRecoveryPersistenceError('settle')
		const raw = JSON.stringify(current)
		try {
			this.storage.removeItem(key)
			if (this.storage.getItem(key) !== null) throw new Error('Marker retained')
			this.notify()
		} catch {
			try {
				if (this.storage.getItem(key) === null) this.storage.setItem(key, raw)
			} catch {
				/* Remain closed in this instance. */
			}
			this.unavailable.add(key)
			this.notify()
			throw new ConfigRecoveryPersistenceError('settle')
		}
	}
}
const stores = new WeakMap<object, StreamTimeoutRecovery>()
export function streamTimeoutRecovery(api: object) {
	let store = stores.get(api)
	if (!store) {
		store = new StreamTimeoutRecovery()
		stores.set(api, store)
	}
	return store
}
