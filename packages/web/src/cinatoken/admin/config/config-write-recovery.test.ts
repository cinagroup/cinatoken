/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CinaTokenApiError } from '../../api'
import { ConfigWebhookInputError } from './config-contracts'
import {
	configAccessLost,
	configErrorKey,
	configWriteUncertain,
} from './config-errors'
import { configFullErrorKey } from './config-full-errors'
import { ConfigRecoveryPersistenceError } from './config-recovery-persistence'
import {
	AdminConfigWriteRecovery,
	adminConfigWriteRecovery,
} from './config-write-recovery'

function tabStorage() {
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

test('unconfirmed write lock survives same-identity remount and never stores input or secret', () => {
	const api = {}
	const first = adminConfigWriteRecovery(api)
	const second = adminConfigWriteRecovery(api)
	assert.equal(first, second)
	let updates = 0
	const unsubscribe = second.subscribe(() => updates++)
	first.mark('user:subject:epoch')
	assert.equal(second.getSnapshot('user:subject:epoch'), true)
	assert.equal(
		adminConfigWriteRecovery({}).getSnapshot('user:subject:epoch'),
		false
	)
	assert.equal(JSON.stringify(first).includes('Asia/Singapore'), false)
	second.settle('user:subject:epoch')
	assert.equal(first.getSnapshot('user:subject:epoch'), false)
	assert.equal(updates, 2)
	unsubscribe()
})

test('scope memory remains bounded and uncertain errors require fresh read rather than write replay', () => {
	const recovery = new AdminConfigWriteRecovery()
	for (let index = 0; index <= recovery.maxScopes; index++)
		recovery.mark(`identity:${index}`)
	assert.equal(recovery.getSnapshot('identity:0'), false)
	assert.equal(recovery.getSnapshot(`identity:${recovery.maxScopes}`), true)
	for (const [status, code, uncertain] of [
		[0, 'timeout', true],
		[409, 'http', true],
		[412, 'http', false],
		[503, 'http', true],
		[400, 'http', false],
		[403, 'http', false],
	] as const) {
		const error = new CinaTokenApiError('Safe error', status, code)
		assert.equal(configWriteUncertain(error), uncertain)
		assert.equal(configAccessLost(error), status === 403)
	}
	assert.equal(configWriteUncertain(new ConfigWebhookInputError()), false)
	const stale = new CinaTokenApiError('Safe error', 412, 'http')
	assert.equal(configErrorKey(stale), 'cinatoken.adminConfigTimezone.conflict')
	assert.equal(configFullErrorKey(stale), 'cinatoken.adminConfigFull.conflict')
})

test('timezone view and full config view share the same pending write authority', () => {
	const api = {}
	const timezoneView = adminConfigWriteRecovery(api)
	const fullView = adminConfigWriteRecovery(api)
	const identity = '["user-a","subject-a",3]'
	fullView.mark(identity, {
		kind: 'timezone',
		value: 'Asia/Singapore',
		acknowledged: false,
	})
	assert.equal(timezoneView.getSnapshot(identity), true)
	assert.deepEqual(timezoneView.getPending(identity), {
		kind: 'timezone',
		value: 'Asia/Singapore',
		acknowledged: false,
	})
	timezoneView.settle(identity)
	assert.equal(fullView.getSnapshot(identity), false)
	timezoneView.mark(identity)
	assert.equal(fullView.getSnapshot(identity), true)
	assert.equal(fullView.getPending(identity), null)
	fullView.settle(identity)
	assert.equal(timezoneView.getSnapshot(identity), false)
})

test('timezone pending bit survives full navigation in either direction without retaining value', () => {
	const storage = tabStorage()
	const identity = '["user-a","subject-a"]'
	const firstPage = new AdminConfigWriteRecovery(storage, true)
	firstPage.mark(identity, {
		kind: 'timezone',
		value: 'Asia/Singapore',
		acknowledged: false,
	})
	assert.deepEqual([...storage.values.values()], ['pending'])
	const secondPage = new AdminConfigWriteRecovery(storage, true)
	assert.equal(secondPage.getSnapshot(identity), true)
	assert.equal(secondPage.getPending(identity), null)
	assert.equal(secondPage.getSnapshot('["user-b","subject-b"]'), false)
	secondPage.settle(identity)
	assert.equal(
		new AdminConfigWriteRecovery(storage, true).getSnapshot(identity),
		false
	)
	const timezonePage = new AdminConfigWriteRecovery(storage, true)
	timezonePage.mark(identity)
	assert.equal(
		new AdminConfigWriteRecovery(storage, true).getSnapshot(identity),
		true
	)
})

test('timezone write fails closed before HTTP when tab storage is unavailable', () => {
	const store = new AdminConfigWriteRecovery(null, true)
	assert.throws(
		() => store.mark('["user-a","subject-a"]'),
		ConfigRecoveryPersistenceError
	)
	assert.equal(store.getSnapshot('["user-a","subject-a"]'), false)
})

test('unreadable timezone storage keeps the recovered lock and rejects a second write before overwriting its marker', () => {
	const storage = tabStorage()
	const identity = '["user-a","subject-a"]'
	new AdminConfigWriteRecovery(storage, true).mark(identity)
	const previous = [...storage.values.values()][0]
	let writes = 0
	let readable = false
	const unreadable = new AdminConfigWriteRecovery(
		{
			getItem: (storageKey) => {
				if (!readable) throw new Error('read denied')
				return storage.getItem(storageKey)
			},
			setItem: (storageKey, value) => {
				writes++
				storage.setItem(storageKey, value)
			},
			removeItem: storage.removeItem,
		},
		true
	)
	assert.equal(unreadable.getSnapshot(identity), true)
	assert.equal(unreadable.getPending(identity), null)
	assert.throws(() => unreadable.mark(identity), ConfigRecoveryPersistenceError)
	assert.equal(writes, 0)
	assert.equal([...storage.values.values()][0], previous)
	assert.throws(
		() => unreadable.settle(identity),
		(error) =>
			error instanceof ConfigRecoveryPersistenceError &&
			error.phase === 'settle'
	)
	assert.equal(unreadable.getSnapshot(identity), true)
	readable = true
	unreadable.settle(identity)
	assert.equal(unreadable.getSnapshot(identity), false)
})
