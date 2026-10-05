/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { configAccessIdentityKey } from '../config/config-access-recovery'

/** A denied list stays closed through Console rechecks and remounts. */
export class UsersAccessRecovery {
	private readonly readBlocked = new Set<string>()
	private readonly writeBlocked = new Set<string>()
	private readonly listeners = new Set<() => void>()

	getReadSnapshot = (key: string): boolean => this.readBlocked.has(key)
	getWriteSnapshot = (key: string): boolean => this.writeBlocked.has(key)
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}
	blockRead(key: string): boolean {
		if (this.readBlocked.has(key)) return false
		this.readBlocked.add(key)
		this.bounded(this.readBlocked)
		this.notify()
		return true
	}
	blockWrite(key: string): void {
		this.writeBlocked.add(key)
		this.bounded(this.writeBlocked)
		this.notify()
	}
	settleRead(key: string): void {
		if (this.readBlocked.delete(key)) this.notify()
	}
	settleWrite(key: string): void {
		if (this.writeBlocked.delete(key)) this.notify()
	}
	private bounded(set: Set<string>): void {
		while (set.size > 32) {
			const oldest = set.values().next().value
			if (oldest) set.delete(oldest)
		}
	}
	private notify(): void {
		for (const listener of this.listeners) listener()
	}
}

const stores = new WeakMap<object, UsersAccessRecovery>()
export function usersAccessRecovery(api: object): UsersAccessRecovery {
	let store = stores.get(api)
	if (!store) {
		store = new UsersAccessRecovery()
		stores.set(api, store)
	}
	return store
}
export const usersAccessIdentityKey = configAccessIdentityKey
