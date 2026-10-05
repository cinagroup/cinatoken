/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
	usersAccessIdentityKey,
	usersAccessRecovery,
} from './users-access-recovery'

test('list denial revalidates once across remounts; write denial leaves read access independent', () => {
	const api = {}
	const first = usersAccessIdentityKey(
		JSON.stringify(['user-a', 'cinaauth-a', 1])
	)
	const after = usersAccessIdentityKey(
		JSON.stringify(['user-a', 'cinaauth-a', 9])
	)
	assert.equal(first, after)
	const access = usersAccessRecovery(api)
	assert.equal(access.blockRead(first), true)
	for (let attempt = 0; attempt < 100; attempt++)
		assert.equal(usersAccessRecovery(api).blockRead(after), false)
	assert.equal(access.getReadSnapshot(after), true)
	access.settleRead(after)
	assert.equal(access.getReadSnapshot(after), false)
	access.blockWrite(after)
	assert.equal(access.getWriteSnapshot(after), true)
	assert.equal(access.getReadSnapshot(after), false)
	access.settleWrite(after)
	assert.equal(access.getWriteSnapshot(after), false)
})
