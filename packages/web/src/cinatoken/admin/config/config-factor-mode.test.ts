/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { configAccessIdentityKey } from './config-access-recovery'
import type { AdminConfigOverview } from './config-contracts'
import { configFactorModeIdentity, factorModeDirty } from './config-factor-mode'
import { reconcileConfigWrite } from './config-full-reconciliation'
import { AdminConfigFullWriteRecovery } from './config-full-write-recovery'
import { ConfigRecoveryPersistenceError } from './config-recovery-persistence'

const overview: AdminConfigOverview = {
	businessTimezone: { value: 'UTC', source: 'missing', revision: null },
	billingCurrency: { value: 'USD', source: 'missing', revision: null },
	routeStrategy: { value: 'hash_affinity', source: 'missing', revision: null },
	webhooks: {
		wecom: { configured: false, revision: null },
		feishu: { configured: false, revision: null },
	},
	canWrite: true,
	canReveal: false,
	userChargedCostFactorMode: {
		value: 'min',
		source: 'configured',
		revision: 'legacy',
	},
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
const key = (epoch: number) =>
	configAccessIdentityKey(JSON.stringify(['user', 'subject', epoch])) +
	':full:factorMode'

test('mode identity requires the verified user and Console subject; dirty tracks saved source without inventing a missing legacy mode', () => {
	assert.deepEqual(configFactorModeIdentity('["user","subject",3]'), {
		expectedUserId: 'user',
		expectedConsoleSubject: 'subject',
	})
	for (const raw of [
		'invalid',
		'["user","subject"]',
		'["user","subject",null]',
		'["user"," subject",1]',
		'["","subject",1]',
	])
		assert.equal(configFactorModeIdentity(raw), null)
	assert.equal(factorModeDirty(undefined, 'min'), false)
	assert.equal(factorModeDirty(overview.userChargedCostFactorMode, null), false)
	assert.equal(
		factorModeDirty(overview.userChargedCostFactorMode, 'multiply'),
		true
	)
	assert.equal(
		factorModeDirty(
			{ value: 'multiply', source: 'missing', revision: null },
			null
		),
		true
	)
})

test('unknown mode outcome survives reload and epoch changes, isolates principals and reconciles only a fresh supported snapshot', () => {
	const tab = storage()
	const first = new AdminConfigFullWriteRecovery(tab, true)
	first.mark(key(1), { kind: 'factorMode', value: 'min', acknowledged: false })
	const reloaded = new AdminConfigFullWriteRecovery(tab, true)
	assert.equal(reloaded.getSnapshot(key(2)), true)
	assert.equal(
		reloaded.getSnapshot('["other-user","subject"]:full:factorMode'),
		false
	)
	const pending = reloaded.getPending(key(2))!
	assert.equal(reconcileConfigWrite(pending, overview), 'matches')
	assert.equal(
		reconcileConfigWrite(pending, {
			...overview,
			userChargedCostFactorMode: undefined,
		}),
		'requires-verification'
	)
	assert.equal(
		reconcileConfigWrite(pending, {
			...overview,
			userChargedCostFactorMode: {
				value: 'multiply',
				source: 'missing',
				revision: null,
			},
		}),
		'differs'
	)
	reloaded.settle(key(2))
	assert.equal(
		new AdminConfigFullWriteRecovery(tab, true).getSnapshot(key(3)),
		false
	)
})

test('corrupt or unreadable mode markers fail closed; missing storage prevents dispatch marking and failed cleanup keeps the lock', () => {
	const tab = storage()
	const first = new AdminConfigFullWriteRecovery(tab, true)
	first.mark(key(1), { kind: 'factorMode', value: 'min', acknowledged: false })
	const persistedKey = [...tab.values.keys()][0]!
	tab.values.set(persistedKey, '{broken')
	const recovered = new AdminConfigFullWriteRecovery(tab, true)
	assert.deepEqual(recovered.getPending(key(1)), {
		kind: 'factorMode',
		value: null,
		acknowledged: false,
	})
	assert.equal(
		reconcileConfigWrite(recovered.getPending(key(1))!, {
			...overview,
			userChargedCostFactorMode: undefined,
		}),
		'requires-verification'
	)
	const unavailable = new AdminConfigFullWriteRecovery(null, true)
	assert.throws(
		() =>
			unavailable.mark(key(1), {
				kind: 'factorMode',
				value: 'min',
				acknowledged: false,
			}),
		ConfigRecoveryPersistenceError
	)
	const unreadable = new AdminConfigFullWriteRecovery(
		{
			...tab,
			getItem: () => {
				throw new Error('denied')
			},
		},
		true
	)
	assert.equal(unreadable.getSnapshot(key(1)), true)
	assert.throws(
		() =>
			unreadable.mark(key(1), {
				kind: 'factorMode',
				value: 'multiply',
				acknowledged: false,
			}),
		ConfigRecoveryPersistenceError
	)
	const cannotClear = new AdminConfigFullWriteRecovery(
		{
			...tab,
			removeItem: () => {
				throw new Error('denied')
			},
		},
		true
	)
	assert.throws(
		() => cannotClear.settle(key(1)),
		ConfigRecoveryPersistenceError
	)
	assert.equal(cannotClear.getSnapshot(key(1)), true)
})
