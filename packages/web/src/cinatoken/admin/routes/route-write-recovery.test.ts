/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RouteWriteRecovery } from './route-write-recovery'

const identity = JSON.stringify(['user-a', 'subject-a', 1])
test('routes unknown generation survives a new API/framework/recheck and is isolated from another identity/domain', () => {
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
	const first = new RouteWriteRecovery(storage)
	const marker = first.markPending(identity, 'routes', 'update')
	const remount = new RouteWriteRecovery(storage)
	assert.equal(
		remount.status(JSON.stringify(['user-a', 'subject-a', 99]), 'routes'),
		'pending'
	)
	assert.equal(
		remount.status(JSON.stringify(['user-b', 'subject-b', 99]), 'routes'),
		'ready'
	)
	assert.deepEqual(remount.marker(identity, 'routes'), marker)
	assert.equal(JSON.stringify([...values]).includes('draft'), false)
	remount.acknowledgeUnknown(identity, marker)
	assert.equal(first.status(identity, 'routes'), 'ready')
})
test('routes unavailable storage rejects dispatch instead of falling back to an evictable memory lock', () => {
	const store = new RouteWriteRecovery(null)
	assert.equal(store.status(identity, 'routes'), 'unavailable')
	assert.throws(() => store.markPending(identity, 'routes', 'delete'))
})
