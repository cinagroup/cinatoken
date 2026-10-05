/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { CinaTokenApiError } from '../../api'
import { GatewayKeyInputError } from './gateway-key-input'
import {
	GatewayKeyWriteRecovery,
	GatewayKeyPersistenceError,
	gatewayKeyWriteUnknown,
	gatewayKeyRecovery,
} from './gateway-key-recovery'

const identity = JSON.stringify(['operator-a', 'subject-a', 1])
function storage() {
	const values = new Map<string, string>()
	return {
		values,
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value)
		},
		removeItem: (key: string) => {
			values.delete(key)
		},
	}
}
test('unknown write remains a non-secret principal lock across reload and epoch, independent of other subjects', () => {
	const tab = storage()
	const first = new GatewayKeyWriteRecovery(tab, true)
	assert.equal(first.status(identity), 'ready')
	first.markPending(identity)
	assert.equal(first.status(identity), 'pending')
	assert.deepEqual([...tab.values.values()], ['pending'])
	const reloaded = new GatewayKeyWriteRecovery(tab, true)
	assert.equal(
		reloaded.status(JSON.stringify(['operator-a', 'subject-a', 2])),
		'pending'
	)
	assert.equal(
		reloaded.status(JSON.stringify(['operator-a', 'subject-b', 2])),
		'ready'
	)
	assert.equal(
		reloaded.status(JSON.stringify(['operator-b', 'subject-a', 2])),
		'ready'
	)
	assert.throws(
		() => reloaded.settleKnown(identity, 'list-2xx' as 'confirmed-2xx'),
		GatewayKeyPersistenceError
	)
	assert.equal(reloaded.status(identity), 'pending')
	reloaded.settleKnown(identity, 'definitive-rejection')
	assert.equal(reloaded.status(identity), 'ready')
})
test('storage read/write/removal failure fails closed and cannot dispatch or erase a pending marker', () => {
	const tab = storage()
	const absent = new GatewayKeyWriteRecovery(null, true)
	assert.equal(absent.status(identity), 'unavailable')
	assert.throws(() => absent.markPending(identity), GatewayKeyPersistenceError)
	const unreadable = new GatewayKeyWriteRecovery(
		{
			...tab,
			getItem: () => {
				throw new Error('blocked')
			},
		},
		true
	)
	assert.equal(unreadable.status(identity), 'unavailable')
	assert.throws(
		() => unreadable.markPending(identity),
		GatewayKeyPersistenceError
	)
	const unwritable = new GatewayKeyWriteRecovery(
		{
			...tab,
			setItem: () => {
				throw new Error('full')
			},
		},
		true
	)
	assert.throws(
		() => unwritable.markPending(identity),
		GatewayKeyPersistenceError
	)
	assert.equal(unwritable.status(identity), 'unavailable')
	assert.equal(tab.values.size, 0)
	const unremovable = new GatewayKeyWriteRecovery(
		{
			...tab,
			removeItem: () => {
				throw new Error('blocked')
			},
		},
		true
	)
	unremovable.markPending(identity)
	assert.throws(
		() => unremovable.settleKnown(identity, 'confirmed-2xx'),
		GatewayKeyPersistenceError
	)
	assert.equal(
		new GatewayKeyWriteRecovery(tab, true).status(identity),
		'pending'
	)
})
test('unknown outcomes retain locks while definitive client/server rejection and local validation can settle', () => {
	for (const error of [
		new Error('network'),
		new CinaTokenApiError('network', 0, 'network'),
		new CinaTokenApiError('server', 503, 'http'),
		new CinaTokenApiError('invalid DTO', 200, 'invalid-response'),
		new CinaTokenApiError('aborted', 0, 'cancelled'),
	])
		assert.equal(gatewayKeyWriteUnknown(error), true)
	for (const error of [
		new CinaTokenApiError('conflict', 409, 'http'),
		new CinaTokenApiError('denied', 403, 'http'),
		new CinaTokenApiError('precondition', 428, 'http'),
		new GatewayKeyInputError(),
	])
		assert.equal(gatewayKeyWriteUnknown(error), false)
})
test('Guardrails denial is independently bounded and does not revoke Keys read/write authority', () => {
	const stores = gatewayKeyRecovery({})
	assert.equal(stores.guardrailAccess.block(identity), true)
	assert.equal(stores.guardrailAccess.block(identity), false)
	assert.equal(stores.access.getSnapshot(identity), false)
	assert.equal(stores.writeAccess.getSnapshot(identity), false)
	stores.writeAccess.block(identity)
	assert.equal(stores.access.getSnapshot(identity), false)
})
