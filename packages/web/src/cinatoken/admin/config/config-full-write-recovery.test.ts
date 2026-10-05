/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AdminConfigOverview } from './config-contracts'
import { reconcileConfigWrite } from './config-full-reconciliation'
import {
	AdminConfigFullWriteRecovery,
	adminConfigFullWriteRecovery,
} from './config-full-write-recovery'
import { ConfigRecoveryPersistenceError } from './config-recovery-persistence'

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

const overview: AdminConfigOverview = {
	businessTimezone: { value: 'UTC', source: 'configured', revision: 'legacy' },
	billingCurrency: { value: 'USD', source: 'configured', revision: 'legacy' },
	routeStrategy: {
		value: 'hash_affinity',
		source: 'configured',
		revision: 'legacy',
	},
	webhooks: {
		wecom: { configured: true, revision: 'legacy' },
		feishu: { configured: false, revision: null },
	},
	canWrite: true,
	canReveal: true,
}

test('one uncertain webhook replacement locks only that channel across remount without retaining URL', () => {
	const api = {}
	const first = adminConfigFullWriteRecovery(api)
	const again = adminConfigFullWriteRecovery(api)
	assert.equal(first, again)
	let changes = 0
	const unsubscribe = again.subscribe(() => changes++)
	first.mark('identity:wecom', {
		kind: 'webhook-replace',
		channel: 'wecom',
		acknowledged: false,
	})
	assert.equal(again.getSnapshot('identity:wecom'), true)
	assert.equal(again.getSnapshot('identity:feishu'), false)
	assert.equal(again.getSnapshot('identity:currency'), false)
	assert.deepEqual(again.getPending('identity:wecom'), {
		kind: 'webhook-replace',
		channel: 'wecom',
		acknowledged: false,
	})
	assert.equal(JSON.stringify(again).includes('https://'), false)
	first.acknowledge('identity:wecom')
	assert.equal(again.getPending('identity:wecom')?.acknowledged, true)
	again.settle('identity:wecom')
	assert.equal(first.getSnapshot('identity:wecom'), false)
	assert.equal(changes, 3)
	unsubscribe()
})

test('recovery scope remains bounded and isolated by API identity', () => {
	const store = new AdminConfigFullWriteRecovery()
	for (let index = 0; index <= store.maxScopes; index++)
		store.mark(`identity:${index}`, {
			kind: 'currency',
			value: 'USD',
			acknowledged: false,
		})
	assert.equal(store.getSnapshot('identity:0'), false)
	assert.equal(store.getSnapshot(`identity:${store.maxScopes}`), true)
	assert.equal(
		adminConfigFullWriteRecovery({}).getSnapshot('identity:160'),
		false
	)
})

test('uncertain webhook marker survives a hard reload without a URL or cross-principal leak', () => {
	const storage = tabStorage()
	const key = '["user-a","subject-a"]:full:wecom'
	const first = new AdminConfigFullWriteRecovery(storage, true)
	const attempt = {
		kind: 'webhook-replace',
		channel: 'wecom',
		acknowledged: false,
		value: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=private',
	} as const
	first.mark(key, attempt)
	assert.equal(storage.values.size, 1)
	assert.equal([...storage.values.values()][0]!.includes('private'), false)
	assert.deepEqual(JSON.parse([...storage.values.values()][0]!), {
		kind: 'webhook-replace',
		channel: 'wecom',
		acknowledged: false,
	})
	const afterReload = new AdminConfigFullWriteRecovery(storage, true)
	assert.equal(afterReload.getSnapshot(key), true)
	assert.equal(
		afterReload.getSnapshot('["user-b","subject-b"]:full:wecom'),
		false
	)
	const pending = afterReload.getPending(key)
	assert.ok(pending)
	assert.equal(
		reconcileConfigWrite(pending, overview, undefined, false),
		'requires-verification'
	)
	afterReload.settle(key)
	assert.equal(
		new AdminConfigFullWriteRecovery(storage, true).getSnapshot(key),
		false
	)
})

test('webhook update cannot start when the tab cannot retain its marker', () => {
	const key = '["user-a","subject-a"]:full:wecom'
	const unavailable = new AdminConfigFullWriteRecovery(null, true)
	assert.throws(
		() =>
			unavailable.mark(key, {
				kind: 'webhook-replace',
				channel: 'wecom',
				acknowledged: false,
			}),
		ConfigRecoveryPersistenceError
	)
	assert.equal(unavailable.getSnapshot(key), false)
	const rejectingStorage = {
		getItem: (_key: string) => null,
		setItem: (_key: string, _value: string) => {
			throw new Error('disabled')
		},
		removeItem: (_key: string) => undefined,
	}
	const rejected = new AdminConfigFullWriteRecovery(rejectingStorage, true)
	assert.throws(
		() =>
			rejected.mark(key, {
				kind: 'webhook-clear',
				channel: 'wecom',
				acknowledged: false,
			}),
		ConfigRecoveryPersistenceError
	)
	assert.equal(rejected.getSnapshot(key), false)
})

test('unreadable webhook storage keeps the recovered lock and rejects a second write before overwriting its marker', () => {
	const storage = tabStorage()
	const key = '["user-a","subject-a"]:full:wecom'
	new AdminConfigFullWriteRecovery(storage, true).mark(key, {
		kind: 'webhook-replace',
		channel: 'wecom',
		acknowledged: false,
	})
	const previous = [...storage.values.values()][0]
	let writes = 0
	let readable = false
	const unreadable = new AdminConfigFullWriteRecovery(
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
	assert.equal(unreadable.getSnapshot(key), true)
	assert.equal(
		unreadable.getSnapshot('["user-a","subject-a"]:full:currency'),
		false
	)
	assert.deepEqual(unreadable.getPending(key), {
		kind: 'webhook-replace',
		channel: 'wecom',
		acknowledged: false,
	})
	assert.throws(
		() =>
			unreadable.mark(key, {
				kind: 'webhook-clear',
				channel: 'wecom',
				acknowledged: false,
			}),
		ConfigRecoveryPersistenceError
	)
	assert.equal(writes, 0)
	assert.equal([...storage.values.values()][0], previous)
	assert.throws(
		() => unreadable.acknowledge(key),
		(error) =>
			error instanceof ConfigRecoveryPersistenceError &&
			error.phase === 'settle'
	)
	assert.equal(writes, 0)
	assert.throws(
		() => unreadable.settle(key),
		(error) =>
			error instanceof ConfigRecoveryPersistenceError &&
			error.phase === 'settle'
	)
	assert.equal(unreadable.getSnapshot(key), true)
	readable = true
	unreadable.settle(key)
	assert.equal(unreadable.getSnapshot(key), false)
})
