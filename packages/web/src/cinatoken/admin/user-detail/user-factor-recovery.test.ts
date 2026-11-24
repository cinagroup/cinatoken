/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { UserFactorRecovery } from './user-factor-recovery'

const identity = JSON.stringify(['operator', 'subject', 1])
function fixture() {
	const values = new Map<string, string>()
	return {
		values,
		storage: {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => {
				values.set(key, value)
			},
			removeItem: (key: string) => {
				values.delete(key)
			},
		},
	}
}
test('uncertain factors survive instances/epochs and isolate user/subject', () => {
	const { storage } = fixture(),
		one = new UserFactorRecovery(storage),
		generation = one.mark(identity, 'user-1'),
		two = new UserFactorRecovery(storage)
	assert.equal(
		two.status(JSON.stringify(['operator', 'subject', 9]), 'user-1'),
		'pending'
	)
	assert.equal(two.status(identity, 'user-2'), 'ready')
	assert.equal(
		two.status(JSON.stringify(['operator', 'other', 1]), 'user-1'),
		'ready'
	)
	assert.equal(two.marker(identity, 'user-1'), generation)
	assert.throws(() => two.mark(identity, 'user-1'))
	two.settle(identity, 'user-1', generation)
	assert.equal(one.status(identity, 'user-1'), 'ready')
})
test('old review cannot clear newer or malformed persisted generations', () => {
	const { storage, values } = fixture(),
		store = new UserFactorRecovery(storage),
		old = store.mark(identity, 'u')
	store.settle(identity, 'u', old)
	const current = store.mark(identity, 'u')
	assert.throws(() => store.settle(identity, 'u', old))
	assert.equal(store.marker(identity, 'u'), current)
	values.set([...values.keys()][0]!, 'bad')
	assert.equal(store.status(identity, 'u'), 'pending')
	assert.equal(store.marker(identity, 'u'), null)
	assert.throws(() => store.settle(identity, 'u', current))
})
test('unavailable storage prevents dispatch; failed clearing restores the pending marker', () => {
	assert.equal(
		new UserFactorRecovery(null).status(identity, 'u'),
		'unavailable'
	)
	const silent = new UserFactorRecovery({
		getItem: () => null,
		setItem: () => {},
		removeItem: () => {},
	})
	assert.throws(() => silent.mark(identity, 'u'))
	assert.equal(silent.status(identity, 'u'), 'unavailable')
	const { storage } = fixture()
	let failRead = false
	const flaky = {
		...storage,
		getItem: (key: string) => {
			if (failRead) {
				failRead = false
				throw new Error('Read failed')
			}
			return storage.getItem(key)
		},
		removeItem: (key: string) => {
			storage.removeItem(key)
			failRead = true
		},
	}
	const store = new UserFactorRecovery(flaky),
		generation = store.mark(identity, 'u')
	assert.throws(() => store.settle(identity, 'u', generation))
	assert.equal(new UserFactorRecovery(storage).status(identity, 'u'), 'pending')
})

test('a generation installed during clearing is never overwritten by the old recovery', () => {
	const { storage } = fixture()
	let replacement = ''
	const interleaved = {
		...storage,
		removeItem: (key: string) => {
			storage.removeItem(key)
			replacement = crypto.randomUUID()
			storage.setItem(key, replacement)
		},
	}
	const store = new UserFactorRecovery(interleaved),
		original = store.mark(identity, 'u')
	assert.throws(() => store.settle(identity, 'u', original))
	assert.equal(
		new UserFactorRecovery(storage).marker(identity, 'u'),
		replacement
	)
})
