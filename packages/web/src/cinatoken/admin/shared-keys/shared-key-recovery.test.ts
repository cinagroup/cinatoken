/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { CinaTokenApiError } from '../../api'
import {
	AdminSharedKeyInputError,
	AdminSharedKeyPersistenceError,
	adminSharedKeyWriteUnknown,
	sanitizeSharedKeyError,
} from './shared-key-errors'
import {
	AdminSharedKeyWriteRecovery,
	adminSharedKeyRecovery,
} from './shared-key-recovery'

const identity = JSON.stringify(['operator', 'subject', 1])
const descriptor = {
	kind: 'governance' as const,
	keyId: 'shared-1',
	operation: 'edit' as const,
}
const reviewDescriptor = {
	kind: 'review' as const,
	operation: 'apply-review' as const,
	since: '2026-09-30T00:00:00.000Z',
	limit: 20,
}
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
test('governance and review unknown results retain separate non-secret principal locks across reload and epoch', () => {
	const tab = storage()
	const governance = new AdminSharedKeyWriteRecovery('governance', tab, true)
	const marker = governance.markPending(identity, descriptor)
	assert.equal(tab.values.size, 2)
	assert.deepEqual(governance.marker(identity), marker)
	const reload = new AdminSharedKeyWriteRecovery('governance', tab, true)
	assert.equal(
		reload.status(JSON.stringify(['operator', 'subject', 2])),
		'pending'
	)
	assert.equal(
		reload.status(JSON.stringify(['operator', 'other-subject', 2])),
		'ready'
	)
	assert.equal(
		reload.status(JSON.stringify(['other-operator', 'subject', 2])),
		'ready'
	)
	assert.equal(
		new AdminSharedKeyWriteRecovery('review', tab, true).status(identity),
		'ready'
	)
	assert.throws(
		() => reload.settleKnown(identity, 'list-2xx' as 'confirmed-2xx', marker),
		AdminSharedKeyPersistenceError
	)
	assert.equal(reload.status(identity), 'pending')
	reload.settleKnown(identity, 'definitive-rejection', marker)
	assert.equal(reload.status(identity), 'ready')
})
test('unreadable or unwritable persistence forbids dispatch; removal failure preserves the marker', () => {
	const tab = storage()
	const absent = new AdminSharedKeyWriteRecovery('governance', null, true)
	assert.equal(absent.status(identity), 'unavailable')
	assert.throws(
		() => absent.markPending(identity, descriptor),
		AdminSharedKeyPersistenceError
	)
	const unreadable = new AdminSharedKeyWriteRecovery(
		'review',
		{
			...tab,
			getItem() {
				throw new Error('blocked')
			},
		},
		true
	)
	assert.equal(unreadable.status(identity), 'unavailable')
	assert.throws(
		() => unreadable.markPending(identity, reviewDescriptor),
		AdminSharedKeyPersistenceError
	)
	const unwritable = new AdminSharedKeyWriteRecovery(
		'governance',
		{
			...tab,
			setItem() {
				throw new Error('full')
			},
		},
		true
	)
	assert.throws(
		() => unwritable.markPending(identity, descriptor),
		AdminSharedKeyPersistenceError
	)
	assert.equal(unwritable.status(identity), 'unavailable')
	const unremovable = new AdminSharedKeyWriteRecovery(
		'review',
		{
			...tab,
			removeItem() {
				throw new Error('blocked')
			},
		},
		true
	)
	const marker = unremovable.markPending(identity, reviewDescriptor)
	assert.throws(
		() => unremovable.settleKnown(identity, 'confirmed-2xx', marker),
		AdminSharedKeyPersistenceError
	)
	assert.equal(
		new AdminSharedKeyWriteRecovery('review', tab, true).status(identity),
		'pending'
	)
})
test('only confirmed results or definitive rejection settle; cancelled, malformed and server failures remain unknown', () => {
	for (const error of [
		new Error('PRIVATE'),
		new CinaTokenApiError('PRIVATE', 0, 'cancelled'),
		new CinaTokenApiError('PRIVATE', 503, 'http'),
		new CinaTokenApiError('PRIVATE', 200, 'invalid-response'),
	])
		assert.equal(adminSharedKeyWriteUnknown(error), true)
	for (const error of [
		new AdminSharedKeyInputError(),
		new AdminSharedKeyPersistenceError(),
		new CinaTokenApiError('PRIVATE', 409, 'http'),
		new CinaTokenApiError('PRIVATE', 403, 'http'),
		new CinaTokenApiError('PRIVATE', 428, 'http'),
	])
		assert.equal(adminSharedKeyWriteUnknown(error), false)
	assert.equal(
		sanitizeSharedKeyError(
			new CinaTokenApiError('PRIVATE FAILURE BODY', 403, 'http')
		).message.includes('PRIVATE'),
		false
	)
})
test('review and audit denials are bounded and independent from shared-key read and governance write', () => {
	const stores = adminSharedKeyRecovery({})
	assert.equal(stores.reviewAccess.block(identity), true)
	assert.equal(stores.reviewAccess.block(identity), false)
	assert.equal(stores.auditAccess.block(identity), true)
	assert.equal(stores.read.getSnapshot(identity), false)
	assert.equal(stores.writeAccess.getSnapshot(identity), false)
})

test('legacy values, malformed v2 markers and inconsistent journals never become ready or silently migrate', () => {
	for (const value of ['pending', '', 'private malformed', 'x'.repeat(1500)]) {
		const tab = storage()
		const store = new AdminSharedKeyWriteRecovery('governance', tab, true)
		const marker = store.markPending(identity, descriptor)
		const pendingKey = [...tab.values.keys()].find((key) =>
			key.includes('.pending.v2:')
		)!
		tab.values.set(pendingKey.replace('.pending.v2:', '.pending.v1:'), value)
		assert.equal(store.status(identity), 'pending')
		assert.equal(store.marker(identity), null)
		assert.throws(
			() => store.acknowledgeUnknown(identity, marker),
			AdminSharedKeyPersistenceError
		)
		assert.equal(
			tab.values.get(pendingKey.replace('.pending.v2:', '.pending.v1:')),
			value
		)
	}
	for (const target of ['pending', 'journal']) {
		const tab = storage()
		const store = new AdminSharedKeyWriteRecovery('governance', tab, true)
		store.markPending(identity, descriptor)
		const key = [...tab.values.keys()].find((value) =>
			value.includes('.' + target + '.')
		)!
		tab.values.set(key, '{"PRIVATE":"not an operation"}')
		assert.equal(
			new AdminSharedKeyWriteRecovery('governance', tab, true).status(identity),
			'pending'
		)
		assert.equal(store.marker(identity), null)
	}
})

test('new generations supersede cleared receipts and late settlement cannot clear or rewrite them', () => {
	const tab = storage()
	const store = new AdminSharedKeyWriteRecovery('governance', tab, true)
	const old = store.markPending(identity, descriptor)
	store.acknowledgeUnknown(identity, old)
	assert.equal(store.status(identity), 'ready')
	const next = store.markPending(identity, {
		...descriptor,
		keyId: 'shared-2',
		operation: 'delete',
	})
	const before = [...tab.values.entries()]
	assert.throws(
		() => store.settleKnown(identity, 'confirmed-2xx', old),
		AdminSharedKeyPersistenceError
	)
	assert.deepEqual([...tab.values.entries()], before)
	assert.deepEqual(store.marker(identity), next)
	assert.equal(
		JSON.stringify([...tab.values.values()]).includes('revision'),
		false
	)
	assert.equal(
		JSON.stringify([...tab.values.values()]).includes('reason'),
		false
	)
})

test('ignored initial writes cannot dispatch and a partially persisted new generation stays locked after reload', () => {
	for (const ignored of ['journal', 'pending']) {
		const tab = storage()
		const store = new AdminSharedKeyWriteRecovery(
			'governance',
			{
				...tab,
				setItem(key, value) {
					if (key.includes('.' + ignored + '.')) return
					tab.setItem(key, value)
				},
			},
			true
		)
		let dispatched = false
		assert.throws(() => {
			store.markPending(identity, descriptor)
			dispatched = true
		}, AdminSharedKeyPersistenceError)
		assert.equal(dispatched, false)
		assert.equal(store.status(identity), 'unavailable')
		if (ignored === 'pending') {
			const reload = new AdminSharedKeyWriteRecovery('governance', tab, true)
			assert.equal(reload.status(identity), 'pending')
			assert.equal(reload.marker(identity)?.kind, 'governance')
		}
	}
})

test('remove success followed by read failure retains a durable clearing journal across reload until a fresh human review', () => {
	const tab = storage()
	let failRead = false
	const store = new AdminSharedKeyWriteRecovery(
		'governance',
		{
			...tab,
			getItem(key) {
				if (failRead) throw new Error('blocked')
				return tab.getItem(key)
			},
			removeItem(key) {
				tab.removeItem(key)
				failRead = true
			},
		},
		true
	)
	const marker = store.markPending(identity, descriptor)
	assert.throws(
		() => store.acknowledgeUnknown(identity, marker),
		AdminSharedKeyPersistenceError
	)
	assert.equal(store.status(identity), 'unavailable')
	const reload = new AdminSharedKeyWriteRecovery('governance', tab, true)
	assert.equal(reload.status(identity), 'pending')
	assert.deepEqual(reload.marker(identity), marker)
	assert.equal(tab.values.size, 1)
	assert.match([...tab.values.values()][0], /"phase":"clearing"/u)
	reload.acknowledgeUnknown(identity, marker)
	assert.equal(reload.status(identity), 'ready')
	assert.match([...tab.values.values()][0], /"phase":"cleared"/u)
})

test('ignored clearing or terminal writes and failed removal preserve non-secret recovery evidence', () => {
	for (const fault of ['clearing', 'cleared', 'remove']) {
		const tab = storage()
		const store = new AdminSharedKeyWriteRecovery(
			'governance',
			{
				...tab,
				setItem(key, value) {
					if (value.includes('"phase":"' + fault + '"')) return
					tab.setItem(key, value)
				},
				removeItem(key) {
					if (fault === 'remove') throw new Error('blocked')
					tab.removeItem(key)
				},
			},
			true
		)
		const marker = store.markPending(identity, descriptor)
		assert.throws(
			() => store.acknowledgeUnknown(identity, marker),
			AdminSharedKeyPersistenceError
		)
		const reload = new AdminSharedKeyWriteRecovery('governance', tab, true)
		assert.equal(reload.status(identity), 'pending')
		assert.deepEqual(reload.marker(identity), marker)
	}
})

test('a persisted terminal receipt allows only a new review after successful reload reads, despite its earlier readback error', () => {
	const tab = storage()
	let terminalWritten = false
	const store = new AdminSharedKeyWriteRecovery(
		'governance',
		{
			...tab,
			setItem(key, value) {
				tab.setItem(key, value)
				if (value.includes('"phase":"cleared"')) terminalWritten = true
			},
			getItem(key) {
				if (terminalWritten) throw new Error('blocked')
				return tab.getItem(key)
			},
		},
		true
	)
	const marker = store.markPending(identity, descriptor)
	assert.throws(
		() => store.acknowledgeUnknown(identity, marker),
		AdminSharedKeyPersistenceError
	)
	assert.equal(store.status(identity), 'unavailable')
	const reload = new AdminSharedKeyWriteRecovery('governance', tab, true)
	assert.equal(reload.status(identity), 'ready')
	const next = reload.markPending(identity, descriptor)
	assert.notEqual(next.generation, marker.generation)
	assert.equal(reload.status(identity), 'pending')
})

test('cleared receipts cannot authorize a new pending generation and mismatched clearing journals are not erased', () => {
	const tab = storage()
	const store = new AdminSharedKeyWriteRecovery('governance', tab, true)
	const old = store.markPending(identity, descriptor)
	store.acknowledgeUnknown(identity, old)
	const journalKey = [...tab.values.keys()][0]
	const oldReceipt = tab.values.get(journalKey)!
	const next = store.markPending(identity, { ...descriptor, keyId: 'shared-2' })
	tab.values.set(journalKey, oldReceipt)
	assert.equal(store.status(identity), 'pending')
	assert.deepEqual(store.marker(identity), next)
	assert.throws(
		() => store.acknowledgeUnknown(identity, old),
		AdminSharedKeyPersistenceError
	)
	tab.values.set(
		journalKey,
		JSON.stringify({ version: 1, phase: 'clearing', marker: old })
	)
	const snapshot = [...tab.values.entries()]
	assert.equal(store.marker(identity), null)
	assert.throws(
		() => store.acknowledgeUnknown(identity, next),
		AdminSharedKeyPersistenceError
	)
	assert.deepEqual([...tab.values.entries()], snapshot)
})
test('success followed by read faults at either pending persistence step leaves a durable fail-closed generation', () => {
	for (const stage of ['journal', 'pending']) {
		const tab = storage()
		let failNext = false
		const store = new AdminSharedKeyWriteRecovery(
			'governance',
			{
				...tab,
				setItem(key, value) {
					tab.setItem(key, value)
					if (key.includes('.' + stage + '.')) failNext = true
				},
				getItem(key) {
					if (failNext) {
						failNext = false
						throw new Error('blocked')
					}
					return tab.getItem(key)
				},
			},
			true
		)
		let dispatched = false
		assert.throws(() => {
			store.markPending(identity, descriptor)
			dispatched = true
		}, AdminSharedKeyPersistenceError)
		assert.equal(dispatched, false)
		const reload = new AdminSharedKeyWriteRecovery('governance', tab, true)
		assert.equal(reload.status(identity), 'pending')
		assert.equal(reload.marker(identity)?.kind, 'governance')
	}
})
test('clearing persistence faults and ignored removal never permit ready after reload', () => {
	for (const stage of [
		'set-clearing',
		'read-clearing',
		'set-terminal',
		'ignored-remove',
	]) {
		const tab = storage()
		let failNext = false
		const store = new AdminSharedKeyWriteRecovery(
			'governance',
			{
				...tab,
				setItem(key, value) {
					if (
						(stage === 'set-clearing' &&
							value.includes('"phase":"clearing"')) ||
						(stage === 'set-terminal' && value.includes('"phase":"cleared"'))
					)
						throw new Error('full')
					tab.setItem(key, value)
					if (stage === 'read-clearing' && value.includes('"phase":"clearing"'))
						failNext = true
				},
				getItem(key) {
					if (failNext) {
						failNext = false
						throw new Error('blocked')
					}
					return tab.getItem(key)
				},
				removeItem(key) {
					if (stage !== 'ignored-remove') tab.removeItem(key)
				},
			},
			true
		)
		const marker = store.markPending(identity, descriptor)
		assert.throws(
			() => store.acknowledgeUnknown(identity, marker),
			AdminSharedKeyPersistenceError
		)
		const reload = new AdminSharedKeyWriteRecovery('governance', tab, true)
		assert.equal(reload.status(identity), 'pending')
		assert.deepEqual(reload.marker(identity), marker)
	}
})
