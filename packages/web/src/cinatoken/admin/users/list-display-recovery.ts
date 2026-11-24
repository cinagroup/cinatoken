/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	AdminConfigAccessRecovery,
	configAccessIdentityKey,
} from '../config/config-access-recovery'

const stores = new WeakMap<object, AdminConfigAccessRecovery>()
const apiIds = new WeakMap<object, number>()
let nextApiId = 0

/** Rechecking the same principal must not create an epoch/401 loop. */
export function markListDisplayUnauthorized(
	api: object,
	reconciliation: string
): boolean {
	let store = stores.get(api)
	if (!store) {
		store = new AdminConfigAccessRecovery()
		stores.set(api, store)
	}
	return store.block(configAccessIdentityKey(reconciliation))
}

export function listDisplayQueryKey(
	scope: string,
	reconciliation: string,
	domain: 'users' | 'gateway-keys' | 'access-keys',
	api: object,
	instance: string
) {
	let id = apiIds.get(api)
	if (id === undefined) {
		id = ++nextApiId
		apiIds.set(api, id)
	}
	return [
		'cinatoken',
		'admin',
		scope,
		domain,
		'display',
		reconciliation,
		id,
		instance,
	] as const
}
