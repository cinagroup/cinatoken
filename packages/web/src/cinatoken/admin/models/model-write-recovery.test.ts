/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ModelWriteRecovery } from './model-write-recovery'

const identity = JSON.stringify(['user-a', 'subject-a', 1])
test('models unknown generation survives a new API/framework/recheck and is isolated from another identity/domain', () => {
	const values = new Map<string, string>()
	const storage = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value)
		},
		removeItem: (key: string) => {
			values.delete(key)
		},
	}
	const first = new ModelWriteRecovery(storage)
	const marker = first.markPending(identity, 'models', 'update')
	const remount = new ModelWriteRecovery(storage)
	assert.equal(
		remount.status(JSON.stringify(['user-a', 'subject-a', 99]), 'models'),
		'pending'
	)
	assert.equal(
		remount.status(JSON.stringify(['user-b', 'subject-b', 99]), 'models'),
		'ready'
	)
	assert.deepEqual(remount.marker(identity, 'models'), marker)
	assert.equal(JSON.stringify([...values]).includes('draft'), false)
	remount.acknowledgeUnknown(identity, marker)
	assert.equal(first.status(identity, 'models'), 'ready')
})
test('models unavailable storage rejects dispatch instead of falling back to an evictable memory lock', () => {
	const store = new ModelWriteRecovery(null)
	assert.equal(store.status(identity, 'models'), 'unavailable')
	assert.throws(() => store.markPending(identity, 'models', 'delete'))
})
