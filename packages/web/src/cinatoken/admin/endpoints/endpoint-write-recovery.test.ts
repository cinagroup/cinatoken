/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EndpointWriteRecovery } from './endpoint-write-recovery'

const identity = JSON.stringify(['user-a', 'subject-a', 1])
test('endpoints unknown generation survives a new API/framework/recheck and is isolated from another identity/domain', () => {
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
	const first = new EndpointWriteRecovery(storage)
	const marker = first.markPending(identity, 'endpoints', 'update')
	const remount = new EndpointWriteRecovery(storage)
	assert.equal(
		remount.status(JSON.stringify(['user-a', 'subject-a', 99]), 'endpoints'),
		'pending'
	)
	assert.equal(
		remount.status(JSON.stringify(['user-b', 'subject-b', 99]), 'endpoints'),
		'ready'
	)
	assert.deepEqual(remount.marker(identity, 'endpoints'), marker)
	assert.equal(JSON.stringify([...values]).includes('draft'), false)
	remount.acknowledgeUnknown(identity, marker)
	assert.equal(first.status(identity, 'endpoints'), 'ready')
})
test('endpoints unavailable storage rejects dispatch instead of falling back to an evictable memory lock', () => {
	const store = new EndpointWriteRecovery(null)
	assert.equal(store.status(identity, 'endpoints'), 'unavailable')
	assert.throws(() => store.markPending(identity, 'endpoints', 'delete'))
})
