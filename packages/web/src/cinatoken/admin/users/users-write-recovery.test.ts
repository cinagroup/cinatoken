/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { usersAccessIdentityKey } from './users-access-recovery'
import {
	UsersWritePersistenceError,
	UsersWriteRecovery,
} from './users-write-recovery'

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
const identity = usersAccessIdentityKey(
	JSON.stringify(['user-a', 'cinaauth-a', 1])
)

test('unknown creation remains locked through a new page controller and portal epoch', () => {
	const tab = storage()
	const first = new UsersWriteRecovery(tab, true)
	assert.equal(first.getSnapshot(identity), false)
	first.markPending(identity)
	assert.equal(first.getSnapshot(identity), true)
	assert.equal(
		JSON.stringify([...tab.values]),
		JSON.stringify([
			[
				`cinatoken.admin.users.create.pending.v1:${encodeURIComponent(identity)}`,
				'pending',
			],
		])
	)
	const reloaded = new UsersWriteRecovery(tab, true)
	const nextEpoch = usersAccessIdentityKey(
		JSON.stringify(['user-a', 'cinaauth-a', 2])
	)
	assert.equal(nextEpoch, identity)
	assert.equal(reloaded.getSnapshot(nextEpoch), true)
	assert.equal(
		reloaded.getSnapshot(
			usersAccessIdentityKey(JSON.stringify(['user-b', 'cinaauth-b', 2]))
		),
		false
	)
	reloaded.settleKnownPost(nextEpoch, 'confirmed-2xx')
	assert.equal(reloaded.getSnapshot(nextEpoch), false)
})

test('an unrelated filtered or paginated list cannot resolve an unknown POST', () => {
	const tab = storage()
	const recovery = new UsersWriteRecovery(tab, true)
	recovery.markPending(identity)
	const unrelatedList = { data: [], total: 0, page: 2, page_size: 20 }
	assert.equal(unrelatedList.data.length, 0)
	assert.throws(
		() =>
			recovery.settleKnownPost(
				identity,
				'list-2xx' as Parameters<UsersWriteRecovery['settleKnownPost']>[1]
			),
		/a user list response cannot resolve a creation outcome/i
	)
	assert.equal(recovery.getSnapshot(identity), true)
	assert.equal(new UsersWriteRecovery(tab, true).getSnapshot(identity), true)
})

test('a definitive POST rejection can release its own marker', () => {
	const recovery = new UsersWriteRecovery(storage(), true)
	recovery.markPending(identity)
	recovery.settleKnownPost(identity, 'definitive-rejection')
	assert.equal(recovery.getSnapshot(identity), false)
})

test('storage read and write failures fail closed before dispatch', () => {
	const unreadable = new UsersWriteRecovery(
		{
			getItem: () => {
				throw new Error('blocked')
			},
			setItem: () => undefined,
			removeItem: () => undefined,
		},
		true
	)
	assert.equal(unreadable.getSnapshot(identity), true)
	assert.equal(unreadable.isStorageUnavailable(identity), true)
	assert.throws(
		() => unreadable.markPending(identity),
		UsersWritePersistenceError
	)
	const unwritable = new UsersWriteRecovery(
		{
			getItem: () => null,
			setItem: () => {
				throw new Error('full')
			},
			removeItem: () => undefined,
		},
		true
	)
	assert.equal(unwritable.getSnapshot(identity), false)
	assert.throws(
		() => unwritable.markPending(identity),
		UsersWritePersistenceError
	)
	assert.equal(unwritable.getSnapshot(identity), false)
	const unavailable = new UsersWriteRecovery(null, true)
	assert.equal(unavailable.getSnapshot(identity), true)
	assert.throws(
		() => unavailable.markPending(identity),
		UsersWritePersistenceError
	)
})

test('failed marker removal retains the lock after a successful but unconfirmed response', () => {
	const tab = storage()
	const recovery = new UsersWriteRecovery(
		{
			getItem: tab.getItem,
			setItem: tab.setItem,
			removeItem: () => {
				throw new Error('denied')
			},
		},
		true
	)
	recovery.markPending(identity)
	assert.throws(
		() => recovery.settleKnownPost(identity, 'confirmed-2xx'),
		UsersWritePersistenceError
	)
	assert.equal(recovery.getSnapshot(identity), true)
	assert.equal(new UsersWriteRecovery(tab, true).getSnapshot(identity), true)
})
