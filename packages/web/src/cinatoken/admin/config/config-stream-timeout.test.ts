/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { adminConfigOverviewSchema } from './config-contracts'
import { normalizeStreamTimeout } from './config-stream-timeout'
import {
	StreamTimeoutRecovery,
	reconcileStreamTimeout,
} from './config-stream-timeout-recovery'

const ms = 'streamFirstEventTimeoutMs'
const groups = 'streamFirstEventTimeoutRouteGroups'
const identity = JSON.stringify(['user', 'subject', 1])
const revision = 'abcdefab-1234-4234-8234-123456789abc'
const next = 'abcdefab-1234-4234-8234-123456789def'
const legacy = {
	businessTimezone: { value: 'UTC', source: 'missing', revision: null },
	billingCurrency: { value: 'USD', source: 'missing', revision: null },
	routeStrategy: { value: 'hash_affinity', source: 'missing', revision: null },
	webhooks: {
		wecom: { configured: false, revision: null },
		feishu: { configured: false, revision: null },
	},
	canWrite: true,
	canReveal: false,
}
function memory() {
	const entries = new Map<string, string>()
	return {
		entries,
		getItem: (key: string) => entries.get(key) ?? null,
		setItem: (key: string, value: string) => {
			entries.set(key, value)
		},
		removeItem: (key: string) => {
			entries.delete(key)
		},
	}
}
test('timeout overview isolates absent capabilities while preserving legacy raw values and stripping secrets', () => {
	const parsed = adminConfigOverviewSchema.parse({
		...legacy,
		streamFirstEventTimeoutMs: {
			value: '10ms',
			source: 'invalid',
			revision,
			secret: 'CANARY',
		},
		streamFirstEventTimeoutRouteGroups: { value: 'all', source: 'configured' },
		secret: 'CANARY',
	})
	assert.deepEqual(parsed.streamFirstEventTimeoutMs, {
		value: '10ms',
		source: 'invalid',
		revision,
	})
	assert.equal(parsed.streamFirstEventTimeoutRouteGroups, undefined)
	assert.equal(JSON.stringify(parsed).includes('CANARY'), false)
	assert.equal(
		adminConfigOverviewSchema.parse(legacy).streamFirstEventTimeoutMs,
		undefined
	)
	for (const field of [
		{ value: '10ms', source: 'configured', revision },
		{ value: '300', source: 'configured', revision: null },
		{ value: '', source: 'configured', revision },
		{ value: '0', source: 'configured', revision: 'bad' },
	]) {
		assert.equal(
			adminConfigOverviewSchema.safeParse({ ...legacy, [ms]: field }).success,
			false
		)
	}
})
test('new inputs preserve group spelling and distinguish zero/empty from malformed duration', () => {
	for (const value of ['', '0', '0010', '2147483647'])
		assert.equal(normalizeStreamTimeout(ms, value), value)
	for (const value of ['1e3', '10ms', '0.1', '-1', '2147483648', 'Infinity'])
		assert.throws(() => normalizeStreamTimeout(ms, value))
	assert.equal(normalizeStreamTimeout(groups, ' VIP,*,vip '), 'VIP,*,vip')
	assert.equal(normalizeStreamTimeout(groups, ' ALL '), 'ALL')
	assert.throws(() => normalizeStreamTimeout(groups, ','))
	assert.throws(() => normalizeStreamTimeout(groups, 'a'.repeat(4097)))
})
test('pending writes survive reload and portal epochs, with principal and field isolation', () => {
	const storage = memory(),
		store = new StreamTimeoutRecovery(storage)
	const marker = store.mark(identity, ms, '1000', 'legacy')
	const reload = new StreamTimeoutRecovery(storage)
	assert.deepEqual(
		reload.marker(JSON.stringify(['user', 'subject', 2]), ms),
		marker
	)
	assert.equal(reload.status(identity, groups), 'ready')
	assert.equal(
		reload.status(JSON.stringify(['other', 'subject', 1]), ms),
		'ready'
	)
	assert.throws(() => reload.mark(identity, ms, '2000', 'legacy'))
	reload.settle(identity, marker)
	const newer = reload.mark(identity, ms, '2000', revision)
	assert.throws(() => store.settle(identity, marker))
	assert.deepEqual(reload.marker(identity, ms), newer)
	assert.throws(() =>
		reload.settle(JSON.stringify(['other', 'subject', 1]), newer)
	)
})
test('reconciliation requires an advanced revision, not an equal value or differently cased UUID', () => {
	const store = new StreamTimeoutRecovery(memory())
	const marker = store.mark(identity, ms, '1000', revision.toUpperCase())
	assert.equal(reconcileStreamTimeout(marker, undefined), 'unknown')
	for (const token of [null, 'legacy', 'LEGACY', revision])
		assert.equal(
			reconcileStreamTimeout(marker, {
				value: '1000',
				source: 'configured',
				revision: token,
			}),
			'unknown'
		)
	assert.equal(
		reconcileStreamTimeout(marker, {
			value: '1000',
			source: 'configured',
			revision: next,
		}),
		'matches'
	)
	assert.equal(
		reconcileStreamTimeout(marker, {
			value: '0',
			source: 'configured',
			revision: next,
		}),
		'differs'
	)
	assert.equal(
		reconcileStreamTimeout(marker, {
			value: '1000',
			source: 'missing',
			revision: next,
		}),
		'unknown'
	)
})
test('corrupt markers, storage failures and silent storage losses cannot unlock a pending write', () => {
	const storage = memory(),
		store = new StreamTimeoutRecovery(storage)
	const marker = store.mark(identity, groups, 'VIP,*', null)
	const key = [...storage.entries.keys()][0]!
	storage.entries.set(key, 'broken')
	assert.equal(
		new StreamTimeoutRecovery(storage).status(identity, groups),
		'pending'
	)
	assert.equal(store.marker(identity, groups), null)
	assert.throws(() => store.settle(identity, marker))
	const lost = new StreamTimeoutRecovery({
		getItem: () => null,
		setItem: () => {},
		removeItem: () => {},
	})
	assert.throws(() => lost.mark(identity, ms, '1', null))
	assert.equal(lost.status(identity, ms), 'unavailable')
	const failing = memory()
	const locked = new StreamTimeoutRecovery({
		...failing,
		removeItem: () => {
			throw new Error('offline')
		},
	})
	const pending = locked.mark(identity, ms, '1', null)
	assert.throws(() => locked.settle(identity, pending))
	assert.equal(
		new StreamTimeoutRecovery(failing).status(identity, ms),
		'pending'
	)
	assert.equal(
		new StreamTimeoutRecovery(null).status(identity, ms),
		'unavailable'
	)
})
