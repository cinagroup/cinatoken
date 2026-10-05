/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
	KeyCreatePersistenceError,
	KeyCreateRecovery,
	UserDetailAccessRecovery,
} from './user-detail-recovery'

function storage() {
	const data = new Map<string, string>()
	return {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => {
			data.set(key, value)
		},
		removeItem: (key: string) => {
			data.delete(key)
		},
		dump: () => JSON.stringify([...data]),
	}
}

test('a key POST marker survives refresh, isolates principal/user, and contains no secret', () => {
	const memory = storage()
	const first = new KeyCreateRecovery(memory, true)
	assert.equal(first.getSnapshot('operator-A', 'user-1'), false)
	first.markPending('operator-A', 'user-1')
	const reload = new KeyCreateRecovery(memory, true)
	assert.equal(reload.getSnapshot('operator-A', 'user-1'), true)
	assert.equal(reload.getSnapshot('operator-A', 'user-2'), false)
	assert.equal(reload.getSnapshot('operator-B', 'user-1'), false)
	assert.equal(memory.dump().includes('secret'), false)
	assert.throws(
		() => reload.markPending('operator-A', 'user-1'),
		KeyCreatePersistenceError
	)
	reload.settleKnownPost('operator-A', 'user-1')
	assert.equal(first.getSnapshot('operator-A', 'user-1'), false)
})

test('storage failure prevents POST, and independent permission domains stay bounded', () => {
	const recovery = new KeyCreateRecovery(null, true)
	assert.equal(recovery.isStorageUnavailable('op', 'user'), true)
	assert.throws(
		() => recovery.markPending('op', 'user'),
		KeyCreatePersistenceError
	)
	const access = new UserDetailAccessRecovery()
	const user = access.key('op', 'user')
	const keys = access.key('op', 'keys')
	assert.equal(access.block(user), true)
	assert.equal(access.block(user), false)
	assert.equal(access.getSnapshot(keys), false)
	access.clear(user)
	assert.equal(access.getSnapshot(user), false)
})

test('denials and uncertain key POST survive portal scope-version revalidation', () => {
	const before = JSON.stringify(['operator-id', 'cinaauth:operator', 4])
	const after = JSON.stringify(['operator-id', 'cinaauth:operator', 5])
	const other = JSON.stringify(['operator-id', 'cinaauth:other', 5])
	const access = new UserDetailAccessRecovery()
	access.block(access.key(before, 'logs'))
	assert.equal(access.getSnapshot(access.key(after, 'logs')), true)
	assert.equal(access.getSnapshot(access.key(other, 'logs')), false)
	assert.equal(access.getSnapshot(access.key(after, 'display')), false)
	const write = new KeyCreateRecovery(storage(), true)
	write.markPending(before, 'user-1')
	assert.equal(write.getSnapshot(after, 'user-1'), true)
	assert.equal(write.getSnapshot(other, 'user-1'), false)
})
