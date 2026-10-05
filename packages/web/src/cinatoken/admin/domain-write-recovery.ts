/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import { configAccessIdentityKey } from './config/config-access-recovery'
import {
	browserSessionStorage,
	type ConfigPendingStorage,
} from './config/config-recovery-persistence'

export const ADMIN_WRITE_DOMAINS = [
	'providers',
	'models',
	'endpoints',
	'routes',
	'presets',
	'guardrails',
	'data-policies',
] as const
export type AdminWriteDomain = (typeof ADMIN_WRITE_DOMAINS)[number]
const markerSchema = z
	.object({
		version: z.literal(1),
		generation: z.string().uuid(),
		domain: z.enum(ADMIN_WRITE_DOMAINS),
		operation: z.string().min(1).max(64),
	})
	.strict()
export type AdminDomainPendingMarker = z.infer<typeof markerSchema>
export class AdminDomainWriteError extends Error {
	readonly code: 'subject' | 'storage' | 'unknown' | 'rejected'
	constructor(
		code: AdminDomainWriteError['code'],
		readonly status = 0,
		readonly serverCode: string | null = null
	) {
		super('The administrative write could not be confirmed')
		this.code = code
	}
}
/** A generation belongs to one identity and business domain across Web/Next remounts. */
export class AdminDomainWriteRecovery {
	private readonly unavailable = new Set<string>()
	private readonly listeners = new Set<() => void>()
	constructor(
		private readonly storage: ConfigPendingStorage | null = browserSessionStorage()
	) {}
	private key(identity: string, domain: AdminWriteDomain): string {
		return (
			'cinatoken.admin.domain.pending.v1:' +
			domain +
			':' +
			encodeURIComponent(configAccessIdentityKey(identity))
		)
	}
	status(
		identity: string,
		domain: AdminWriteDomain
	): 'ready' | 'pending' | 'unavailable' {
		const key = this.key(identity, domain)
		if (!this.storage || this.unavailable.has(key)) return 'unavailable'
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
		domain: AdminWriteDomain
	): AdminDomainPendingMarker | null {
		if (this.status(identity, domain) !== 'pending' || !this.storage)
			return null
		try {
			const raw = this.storage.getItem(this.key(identity, domain))
			if (raw === null) return null
			const parsed = markerSchema.safeParse(JSON.parse(raw) as unknown)
			return parsed.success && parsed.data.domain === domain
				? parsed.data
				: null
		} catch {
			return null
		}
	}
	markPending(
		identity: string,
		domain: AdminWriteDomain,
		operation: string
	): AdminDomainPendingMarker {
		if (!this.storage || this.status(identity, domain) !== 'ready')
			throw new AdminDomainWriteError('storage')
		const key = this.key(identity, domain)
		try {
			const marker = markerSchema.parse({
				version: 1,
				generation: crypto.randomUUID(),
				domain,
				operation,
			})
			const raw = JSON.stringify(marker)
			this.storage.setItem(key, raw)
			if (this.storage.getItem(key) !== raw)
				throw new Error('Marker was not retained')
			this.notify()
			return marker
		} catch {
			this.unavailable.add(key)
			this.notify()
			throw new AdminDomainWriteError('storage')
		}
	}
	settleKnown(
		identity: string,
		marker: AdminDomainPendingMarker,
		outcome: 'confirmed-2xx' | 'definitive-rejection'
	): void {
		if (!['confirmed-2xx', 'definitive-rejection'].includes(outcome))
			throw new AdminDomainWriteError('storage')
		this.clearMatching(identity, marker)
	}
	/** Only an explicit fresh-subject observation and two human confirmations authorize this. */
	acknowledgeUnknown(identity: string, marker: AdminDomainPendingMarker): void {
		this.clearMatching(identity, marker)
	}
	private clearMatching(
		identity: string,
		marker: AdminDomainPendingMarker
	): void {
		const key = this.key(identity, marker.domain)
		const raw = JSON.stringify(markerSchema.parse(marker))
		if (!this.storage) throw new AdminDomainWriteError('storage')
		let current: string | null
		try {
			current = this.storage.getItem(key)
		} catch {
			this.unavailable.add(key)
			this.notify()
			throw new AdminDomainWriteError('storage')
		}
		// A known mismatch leaves its newer owner intact and observable.
		if (current !== raw) throw new AdminDomainWriteError('storage')
		let removalAttempted = false
		try {
			removalAttempted = true
			this.storage.removeItem(key)
			if (this.storage.getItem(key) !== null)
				throw new Error('Marker could not be cleared')
			this.notify()
		} catch {
			// A remove may succeed before the readback fails. Restore the original
			// generation synchronously so a reload cannot silently clear that lock.
			if (removalAttempted && this.storage) {
				try {
					this.storage.setItem(key, raw)
				} catch {
					/* Keep the current view fail closed. */
				}
			}
			this.unavailable.add(key)
			this.notify()
			throw new AdminDomainWriteError('storage')
		}
	}
}
let browserRecovery: AdminDomainWriteRecovery | undefined
export function adminDomainWriteRecovery(): AdminDomainWriteRecovery {
	return (browserRecovery ??= new AdminDomainWriteRecovery())
}
export function adminDomainIdentity(
	identity: string
): { userId: string; subject: string } | null {
	try {
		const parsed: unknown = JSON.parse(configAccessIdentityKey(identity))
		if (
			Array.isArray(parsed) &&
			parsed.length === 2 &&
			parsed.every((value) => typeof value === 'string' && value.length > 0)
		)
			return { userId: parsed[0] as string, subject: parsed[1] as string }
	} catch {
		/* Invalid identities cannot authorize a write. */
	}
	return null
}
