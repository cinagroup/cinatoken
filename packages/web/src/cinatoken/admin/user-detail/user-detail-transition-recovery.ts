/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { configAccessIdentityKey } from '../config/config-access-recovery'
import {
	browserSessionStorage,
	type ConfigPendingStorage,
} from '../config/config-recovery-persistence'

const prefix = 'cinatoken.admin.user-detail.budget-transition.pending.v1:'

export class BudgetTransitionPersistenceError extends Error {
	constructor() {
		super('Cannot retain budget transition safety marker in this tab')
		this.name = 'BudgetTransitionPersistenceError'
	}
}

/** An uncertain POST stays locked across reloads; a GET never clears the marker. */
export class BudgetTransitionRecovery {
	private readonly listeners = new Set<() => void>()
	constructor(
		private readonly storage: ConfigPendingStorage | null = browserSessionStorage(),
		private readonly requireStorage = typeof window !== 'undefined'
	) {}
	private key(identity: string, userId: string): string {
		return (
			prefix +
			encodeURIComponent(
				JSON.stringify([configAccessIdentityKey(identity), userId])
			)
		)
	}
	getSnapshot = (identity: string, userId: string): boolean => {
		if (!this.requireStorage) return false
		if (!this.storage) return true
		try {
			return this.storage.getItem(this.key(identity, userId)) !== null
		} catch {
			return true
		}
	}
	isStorageUnavailable(identity: string, userId: string): boolean {
		if (!this.requireStorage) return false
		if (!this.storage) return true
		try {
			this.storage.getItem(this.key(identity, userId))
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
			throw new BudgetTransitionPersistenceError()
		try {
			this.storage.setItem(this.key(identity, userId), 'pending')
		} catch {
			throw new BudgetTransitionPersistenceError()
		}
		this.notify()
	}
	settleKnownPost(identity: string, userId: string): void {
		if (this.requireStorage) {
			if (!this.storage) throw new BudgetTransitionPersistenceError()
			try {
				this.storage.removeItem(this.key(identity, userId))
			} catch {
				throw new BudgetTransitionPersistenceError()
			}
		}
		this.notify()
	}
	private notify(): void {
		for (const listener of this.listeners) listener()
	}
}

const stores = new WeakMap<object, BudgetTransitionRecovery>()
export function budgetTransitionRecovery(
	api: object
): BudgetTransitionRecovery {
	let store = stores.get(api)
	if (!store) {
		store = new BudgetTransitionRecovery()
		stores.set(api, store)
	}
	return store
}
