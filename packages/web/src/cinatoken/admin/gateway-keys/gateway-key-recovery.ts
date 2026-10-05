/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { CinaTokenApiError } from '../../api'
import { AccessKeyAccessRecovery } from '../access-keys/access-key-recovery'
import { configAccessIdentityKey } from '../config/config-access-recovery'
import {
	browserSessionStorage,
	type ConfigPendingStorage,
} from '../config/config-recovery-persistence'
import { GatewayKeyInputError } from './gateway-key-metadata'

export class GatewayKeyPersistenceError extends Error {
	constructor() {
		super('Cannot retain Gateway key write marker')
		this.name = 'GatewayKeyPersistenceError'
	}
}
export class GatewayKeyWriteRecovery {
	private readonly listeners = new Set<() => void>()
	private readonly unavailable = new Set<string>()
	constructor(
		private readonly storage: ConfigPendingStorage | null = browserSessionStorage(),
		private readonly requireStorage = typeof window !== 'undefined'
	) {}
	private key(identity: string): string {
		return (
			'cinatoken.admin.gateway-keys.write.pending.v1:' +
			encodeURIComponent(configAccessIdentityKey(identity))
		)
	}
	status(identity: string): 'ready' | 'pending' | 'unavailable' {
		if (this.unavailable.has(this.key(identity))) return 'unavailable'
		if (!this.requireStorage) return 'ready'
		if (!this.storage) return 'unavailable'
		try {
			return this.storage.getItem(this.key(identity)) === null
				? 'ready'
				: 'pending'
		} catch {
			return 'unavailable'
		}
	}
	subscribe = (listener: () => void) => {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}
	markPending(identity: string): void {
		if (this.status(identity) !== 'ready' || !this.storage)
			throw new GatewayKeyPersistenceError()
		try {
			this.storage.setItem(this.key(identity), 'pending')
		} catch {
			this.unavailable.add(this.key(identity))
			this.listeners.forEach((listener) => listener())
			throw new GatewayKeyPersistenceError()
		}
		this.listeners.forEach((listener) => listener())
	}
	settleKnown(
		identity: string,
		outcome: 'confirmed-2xx' | 'definitive-rejection'
	): void {
		if (!['confirmed-2xx', 'definitive-rejection'].includes(outcome))
			throw new GatewayKeyPersistenceError()
		if (this.requireStorage) {
			if (!this.storage) throw new GatewayKeyPersistenceError()
			try {
				this.storage.removeItem(this.key(identity))
			} catch {
				throw new GatewayKeyPersistenceError()
			}
		}
		this.listeners.forEach((listener) => listener())
	}
}
const writes = new WeakMap<object, GatewayKeyWriteRecovery>()
const access = new WeakMap<object, AccessKeyAccessRecovery>()
const writeAccess = new WeakMap<object, AccessKeyAccessRecovery>()
const guardrailAccess = new WeakMap<object, AccessKeyAccessRecovery>()
export function gatewayKeyRecovery(api: object) {
	let writeStore = writes.get(api)
	if (!writeStore) {
		writeStore = new GatewayKeyWriteRecovery()
		writes.set(api, writeStore)
	}
	let accessStore = access.get(api)
	if (!accessStore) {
		accessStore = new AccessKeyAccessRecovery()
		access.set(api, accessStore)
	}
	let writeAccessStore = writeAccess.get(api)
	if (!writeAccessStore) {
		writeAccessStore = new AccessKeyAccessRecovery()
		writeAccess.set(api, writeAccessStore)
	}
	let guardrailStore = guardrailAccess.get(api)
	if (!guardrailStore) {
		guardrailStore = new AccessKeyAccessRecovery()
		guardrailAccess.set(api, guardrailStore)
	}
	return {
		write: writeStore,
		access: accessStore,
		writeAccess: writeAccessStore,
		guardrailAccess: guardrailStore,
	}
}
export function gatewayKeyAccessDenied(error: unknown): boolean {
	return (
		error instanceof CinaTokenApiError &&
		(error.status === 401 || error.status === 403)
	)
}
export function gatewayKeyWriteUnknown(error: unknown): boolean {
	if (
		error instanceof GatewayKeyInputError ||
		error instanceof GatewayKeyPersistenceError
	)
		return false
	return (
		!(error instanceof CinaTokenApiError) ||
		error.status === 0 ||
		error.status >= 500 ||
		['network', 'timeout', 'cancelled', 'invalid-response'].includes(error.code)
	)
}
