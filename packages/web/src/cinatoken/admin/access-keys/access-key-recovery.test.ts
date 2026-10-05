/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
	AccessKeyAccessRecovery,
	AccessKeyWritePersistenceError,
	AccessKeyWriteRecovery,
} from './access-key-recovery'

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
const alice = JSON.stringify(['user:alice', 'cinaauth:alice', 1])
const aliceRefreshed = JSON.stringify(['user:alice', 'cinaauth:alice', 2])
const otherSubject = JSON.stringify(['user:alice', 'cinaauth:other', 1])

test('unknown create, edit, rotation or status marker survives reload and epoch changes for only its principal', () => {
	const persistence = storage()
	const first = new AccessKeyWriteRecovery(persistence, true)
	assert.equal(first.status(alice), 'ready')
	first.markPending(alice)
	const reload = new AccessKeyWriteRecovery(persistence, true)
	assert.equal(reload.status(aliceRefreshed), 'pending')
	assert.equal(reload.status(otherSubject), 'ready')
	assert.throws(
		() => reload.markPending(aliceRefreshed),
		AccessKeyWritePersistenceError
	)
	assert.deepEqual([...persistence.values.values()], ['pending'])
	assert.equal(
		JSON.stringify([...persistence.values]).includes('secret_key'),
		false
	)
	// Only a confirmed response explicitly settles the marker; reading a list has no recovery method.
	reload.settleKnown(aliceRefreshed)
	assert.equal(first.status(alice), 'ready')
})

test('storage rejection disables writes before dispatch and failure to settle keeps the marker', () => {
	const unavailable = new AccessKeyWriteRecovery(null, true)
	assert.equal(unavailable.status(alice), 'unavailable')
	assert.throws(
		() => unavailable.markPending(alice),
		AccessKeyWritePersistenceError
	)
	const persistence = storage()
	const store = new AccessKeyWriteRecovery(
		{
			...persistence,
			removeItem: () => {
				throw new Error('Storage blocked')
			},
		},
		true
	)
	store.markPending(alice)
	assert.throws(() => store.settleKnown(alice), AccessKeyWritePersistenceError)
	assert.equal(store.status(alice), 'pending')
	const rejected = new AccessKeyWriteRecovery(
		{
			...persistence,
			setItem: () => {
				throw new Error('Storage full')
			},
		},
		true
	)
	assert.throws(
		() => rejected.markPending(otherSubject),
		AccessKeyWritePersistenceError
	)
	assert.equal(rejected.status(otherSubject), 'ready')
})

test('one denied identity triggers only one console recheck across epoch changes and remounts', () => {
	const access = new AccessKeyAccessRecovery()
	let notifications = 0
	const unsubscribe = access.subscribe(() => {
		notifications++
	})
	assert.equal(access.block(alice), true)
	assert.equal(access.getSnapshot(aliceRefreshed), true)
	assert.equal(access.block(aliceRefreshed), false)
	assert.equal(access.getSnapshot(otherSubject), false)
	assert.equal(notifications, 1)
	unsubscribe()
})
