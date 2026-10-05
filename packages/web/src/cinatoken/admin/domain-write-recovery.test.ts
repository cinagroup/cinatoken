/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	AdminDomainWriteRecovery,
	adminDomainIdentity,
} from './domain-write-recovery'

const identity = JSON.stringify(['u', 'subject-a', 1])
function fixture() {
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
	return { values, storage, store: new AdminDomainWriteRecovery(storage) }
}
test('markers contain only version/generation/domain/operation and cannot evict unresolved identities', () => {
	const { values, store } = fixture()
	store.markPending(identity, 'providers', 'resource')
	for (let index = 0; index < 200; index++)
		store.markPending(
			JSON.stringify(['u-' + index, 's', 0]),
			'providers',
			'delete'
		)
	assert.equal(store.status(identity, 'providers'), 'pending')
	for (const value of values.values())
		assert.deepEqual(Object.keys(JSON.parse(value)).sort(), [
			'domain',
			'generation',
			'operation',
			'version',
		])
	assert.equal(values.size, 201)
})
test('revalidation epoch changes do not clear locks; other domain, user or subject cannot inherit them', () => {
	const { store } = fixture()
	store.markPending(identity, 'models', 'update')
	assert.equal(
		store.status(JSON.stringify(['u', 'subject-a', 999]), 'models'),
		'pending'
	)
	assert.equal(
		store.status(JSON.stringify(['u', 'subject-b', 1]), 'models'),
		'ready'
	)
	assert.equal(
		store.status(JSON.stringify(['v', 'subject-a', 1]), 'models'),
		'ready'
	)
	assert.equal(store.status(identity, 'routes'), 'ready')
	assert.deepEqual(adminDomainIdentity(identity), {
		userId: 'u',
		subject: 'subject-a',
	})
	assert.equal(adminDomainIdentity('invalid'), null)
})
test('a second writer cannot replace an unresolved generation and a stale acknowledgement cannot clear a new generation', () => {
	const { store, storage } = fixture()
	const old = store.markPending(identity, 'endpoints', 'update')
	assert.throws(() => store.markPending(identity, 'endpoints', 'delete'))
	store.settleKnown(identity, old, 'confirmed-2xx')
	const replacement = store.markPending(identity, 'endpoints', 'delete')
	const another = new AdminDomainWriteRecovery(storage)
	assert.throws(() => another.acknowledgeUnknown(identity, old))
	assert.equal(store.status(identity, 'endpoints'), 'pending')
	assert.deepEqual(store.marker(identity, 'endpoints'), replacement)
})
test('storage read/set/readback/remove/readback failures remain locked and block dispatch', () => {
	for (const kind of [
		'get',
		'set',
		'readback',
		'remove',
		'remove-readback',
	] as const) {
		const values = new Map<string, string>()
		let written = false
		let removed = false
		const storage = {
			getItem: (key: string) => {
				if (
					kind === 'get' ||
					(kind === 'readback' && written) ||
					(kind === 'remove-readback' && removed)
				)
					throw new Error('Unavailable')
				return values.get(key) ?? null
			},
			setItem: (key: string, value: string) => {
				if (kind === 'set') throw new Error('Unavailable')
				values.set(key, value)
				written = true
			},
			removeItem: (key: string) => {
				if (kind === 'remove') throw new Error('Unavailable')
				values.delete(key)
				removed = true
			},
		}
		const store = new AdminDomainWriteRecovery(storage)
		if (kind === 'remove' || kind === 'remove-readback') {
			const marker = store.markPending(identity, 'routes', 'update')
			assert.throws(() => store.settleKnown(identity, marker, 'confirmed-2xx'))
		} else assert.throws(() => store.markPending(identity, 'routes', 'update'))
		assert.equal(store.status(identity, 'routes'), 'unavailable')
		assert.throws(() => store.markPending(identity, 'routes', 'delete'))
	}
})
test('malformed marker is locked and cannot be manually acknowledged as another operation', () => {
	const { store, values } = fixture()
	store.markPending(identity, 'routes', 'update')
	const key = [...values.keys()][0]!
	values.set(
		key,
		'{"version":1,"domain":"routes","generation":"invalid","operation":"write"}'
	)
	assert.equal(store.status(identity, 'routes'), 'pending')
	assert.equal(store.marker(identity, 'routes'), null)
})
test('subscribers share changes across views and cleanup leaves no stale listener', () => {
	const { store } = fixture()
	let notifications = 0
	const stop = store.subscribe(() => notifications++)
	const marker = store.markPending(identity, 'models', 'delete')
	assert.equal(notifications, 1)
	store.settleKnown(identity, marker, 'definitive-rejection')
	assert.equal(notifications, 2)
	stop()
	store.markPending(identity, 'models', 'update')
	assert.equal(notifications, 2)
})
test('a successful remove followed by failed readback restores the old marker across a reload', () => {
	const values = new Map<string, string>()
	let removed = false
	const storage = {
		getItem: (key: string) => {
			if (removed) {
				removed = false
				throw new Error('Readback unavailable')
			}
			return values.get(key) ?? null
		},
		setItem: (key: string, value: string) => {
			values.set(key, value)
		},
		removeItem: (key: string) => {
			values.delete(key)
			removed = true
		},
	}
	const store = new AdminDomainWriteRecovery(storage)
	const marker = store.markPending(identity, 'providers', 'update')
	assert.throws(() => store.settleKnown(identity, marker, 'confirmed-2xx'))
	assert.equal(store.status(identity, 'providers'), 'unavailable')
	const reloaded = new AdminDomainWriteRecovery(storage)
	assert.equal(reloaded.status(identity, 'providers'), 'pending')
	assert.deepEqual(reloaded.marker(identity, 'providers'), marker)
})
