/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConfigPendingStorage } from '../config/config-recovery-persistence'
import { ToolWriteRecovery } from './tools-recovery'

const identity = JSON.stringify(['user', 'tools-subject', 1]),
	descriptor = {
		family: 'web-search',
		provider: 'bocha',
		operation: 'save',
	} as const
class Storage implements ConfigPendingStorage {
	values = new Map<string, string>()
	ignore: string | null = null
	ignorePending = false
	failRead = false
	failAfterRemove = false
	failAfterReceipt = false
	getItem(key: string) {
		if (this.failRead) {
			this.failRead = false
			throw new Error('Read unavailable')
		}
		return this.values.get(key) ?? null
	}
	setItem(key: string, value: string) {
		if (
			(this.ignore && value.includes(this.ignore)) ||
			(this.ignorePending && key.includes('.pending.v2:'))
		)
			return
		this.values.set(key, value)
		if (this.failAfterReceipt && value.includes('"phase":"cleared"'))
			this.failRead = true
	}
	removeItem(key: string) {
		this.values.delete(key)
		if (this.failAfterRemove) this.failRead = true
	}
}
test('journal contains only bounded metadata and persists across hard reload per exact subject', () => {
	const storage = new Storage(),
		store = new ToolWriteRecovery(storage, true),
		marker = store.markPending(identity, descriptor)
	assert.equal(Object.isFrozen(marker), true)
	assert.equal(new ToolWriteRecovery(storage, true).status(identity), 'pending')
	assert.equal(store.status(JSON.stringify(['user', 'other', 1])), 'ready')
	assert.equal(
		[...storage.values.values()].some((raw) =>
			/reason|revision|secret|value/u.test(raw)
		),
		false
	)
	assert.equal(
		store.status(JSON.stringify(['user', 'tools-subject', 2])),
		'pending'
	)
})
test('legacy, malformed, mismatched journal and unavailable storage fail closed', () => {
	assert.equal(
		new ToolWriteRecovery(null, true).status(identity),
		'unavailable'
	)
	const storage = new Storage(),
		store = new ToolWriteRecovery(storage, true),
		marker = store.markPending(identity, descriptor)
	const key = [...storage.values.keys()].find((key) =>
		key.includes('.pending.v2:')
	)!
	storage.values.set(key.replace('.v2:', '.v1:'), 'pending')
	assert.equal(store.marker(identity), null)
	assert.throws(() => store.acknowledgeUnknown(identity, marker))
	storage.values.delete(key.replace('.v2:', '.v1:'))
	storage.values.set(key, 'malformed')
	assert.equal(store.status(identity), 'pending')
	assert.equal(store.marker(identity), null)
})
test('ignored writes never permit dispatch; a retained journal remains locked across reload', () => {
	for (const mode of ['journal', 'pending']) {
		const storage = new Storage()
		if (mode === 'journal') storage.ignore = '"phase":"pending"'
		else storage.ignorePending = true
		const store = new ToolWriteRecovery(storage, true)
		assert.throws(() => store.markPending(identity, descriptor))
		assert.equal(store.status(identity), 'unavailable')
		const reload = new ToolWriteRecovery(storage, true)
		if (mode === 'pending') assert.equal(reload.status(identity), 'pending')
		else assert.equal(reload.status(identity), 'ready')
	}
})
test('terminal receipt may allow new review after reload only when both pending markers are empty', () => {
	const storage = new Storage(),
		store = new ToolWriteRecovery(storage, true),
		marker = store.markPending(identity, descriptor)
	storage.failAfterReceipt = true
	assert.throws(() => store.acknowledgeUnknown(identity, marker))
	assert.equal(store.status(identity), 'unavailable')
	const reload = new ToolWriteRecovery(storage, true)
	assert.equal(reload.status(identity), 'ready')
	const journal = [...storage.values.keys()].find((key) =>
		key.includes('.journal.')
	)!
	storage.values.set(journal.replace('.journal.v1:', '.pending.v1:'), 'legacy')
	assert.equal(new ToolWriteRecovery(storage, true).status(identity), 'pending')
})
test('remove succeeded then read throws leaves durable clearing marker for reload and manual reread', () => {
	const storage = new Storage(),
		store = new ToolWriteRecovery(storage, true),
		marker = store.markPending(identity, descriptor)
	storage.failAfterRemove = true
	assert.throws(() => store.acknowledgeUnknown(identity, marker))
	assert.equal(store.status(identity), 'unavailable')
	const reload = new ToolWriteRecovery(storage, true)
	assert.equal(reload.status(identity), 'pending')
	assert.deepEqual(reload.marker(identity), marker)
	storage.failAfterRemove = false
	reload.acknowledgeUnknown(identity, marker)
	assert.equal(new ToolWriteRecovery(storage, true).status(identity), 'ready')
})
test('ignored clearing or terminal receipt retains unknown across reload', () => {
	for (const phase of ['clearing', 'cleared']) {
		const storage = new Storage(),
			store = new ToolWriteRecovery(storage, true),
			marker = store.markPending(identity, descriptor)
		storage.ignore = '"phase":"' + phase + '"'
		assert.throws(() => store.acknowledgeUnknown(identity, marker))
		assert.equal(
			new ToolWriteRecovery(storage, true).status(identity),
			'pending'
		)
	}
})
test('old generation settle cannot clear a newer request or replay an old operation', () => {
	const storage = new Storage(),
		store = new ToolWriteRecovery(storage, true),
		first = store.markPending(identity, descriptor)
	store.settleKnown(identity, 'confirmed-2xx', first)
	const second = store.markPending(identity, {
		...descriptor,
		operation: 'reveal',
	})
	assert.notEqual(first.generation, second.generation)
	assert.throws(() => store.settleKnown(identity, 'confirmed-2xx', first))
	assert.deepEqual(store.marker(identity), second)
	store.acknowledgeUnknown(identity, second)
	assert.equal(store.status(identity), 'ready')
})
