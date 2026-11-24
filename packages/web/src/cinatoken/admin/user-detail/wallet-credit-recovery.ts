/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import { configAccessIdentityKey } from '../config/config-access-recovery'
import {
	browserSessionStorage,
	type ConfigPendingStorage,
} from '../config/config-recovery-persistence'
import {
	WalletCreditClientError,
	walletCreditInputSchema,
	walletCreditMatches,
	walletCreditReceiptSchema,
	type WalletCreditInput,
	type WalletCreditReceipt,
} from './wallet-credit-contracts'

const markerSchema = z
	.object({
		version: z.literal(1),
		generation: z.string().uuid(),
		userId: z.string().uuid(),
		input: walletCreditInputSchema,
	})
	.strict()
export type WalletCreditMarker = z.infer<typeof markerSchema>
/** This tab retains the frozen non-secret order, never a cookie or API key. */
export class WalletCreditRecovery {
	private listeners = new Set<() => void>()
	private unavailable = new Set<string>()
	constructor(
		private storage: ConfigPendingStorage | null = browserSessionStorage()
	) {}
	private key(identity: string, userId: string) {
		return (
			'cinatoken.admin.wallet-credit.pending.v1:' +
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
	marker(identity: string, userId: string): WalletCreditMarker | null {
		try {
			const raw = this.storage?.getItem(this.key(identity, userId))
			if (!raw) return null
			const parsed = markerSchema.safeParse(JSON.parse(raw) as unknown)
			return parsed.success && parsed.data.userId === userId
				? parsed.data
				: null
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
		userId: string,
		input: WalletCreditInput
	): WalletCreditMarker {
		if (!this.storage || this.status(identity, userId) !== 'ready')
			throw new WalletCreditClientError('storage')
		const key = this.key(identity, userId)
		try {
			const marker = markerSchema.parse({
				version: 1,
				generation: crypto.randomUUID(),
				userId,
				input,
			})
			const raw = JSON.stringify(marker)
			this.storage.setItem(key, raw)
			if (this.storage.getItem(key) !== raw) throw new Error('Marker missing')
			this.notify()
			return marker
		} catch {
			this.unavailable.add(key)
			this.notify()
			throw new WalletCreditClientError('storage')
		}
	}
	confirm(
		identity: string,
		marker: WalletCreditMarker,
		receipt: WalletCreditReceipt
	) {
		if (
			!walletCreditReceiptSchema.safeParse(receipt).success ||
			!walletCreditMatches(receipt, marker.userId, marker.input)
		)
			throw new WalletCreditClientError('conflict')
		this.clearMatching(identity, marker)
	}
	/** Only a definite rejection of this very dispatch may clear without a receipt. */
	reject(identity: string, marker: WalletCreditMarker) {
		this.clearMatching(identity, marker)
	}
	private clearMatching(identity: string, marker: WalletCreditMarker) {
		const key = this.key(identity, marker.userId),
			current = this.marker(identity, marker.userId)
		if (
			!this.storage ||
			current?.generation !== marker.generation ||
			JSON.stringify(current.input) !== JSON.stringify(marker.input)
		)
			throw new WalletCreditClientError('storage')
		const raw = JSON.stringify(current)
		try {
			this.storage.removeItem(key)
			if (this.storage.getItem(key) !== null) throw new Error('Marker retained')
			this.notify()
		} catch {
			try {
				if (this.storage.getItem(key) === null) this.storage.setItem(key, raw)
			} catch {
				/* Keep this instance closed. */
			}
			this.unavailable.add(key)
			this.notify()
			throw new WalletCreditClientError('storage')
		}
	}
}
let browserStore: WalletCreditRecovery | undefined
export function walletCreditRecovery() {
	return (browserStore ??= new WalletCreditRecovery())
}
