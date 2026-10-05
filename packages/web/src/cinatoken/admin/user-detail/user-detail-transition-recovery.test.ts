/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { BudgetTransitionRecovery } from './user-detail-transition-recovery'

function storage() {
	const data = new Map<string, string>()
	return {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => {
			data.set(key, value)
		},
		removeItem: (key: string) => {
			data.delete(key)
		},
		data,
	}
}

test('uncertain budget transition survives reload and isolates principal and user', () => {
	const backend = storage()
	const first = new BudgetTransitionRecovery(backend, true)
	first.markPending('principal-a', 'user-a')
	const reloaded = new BudgetTransitionRecovery(backend, true)
	assert.equal(reloaded.getSnapshot('principal-a', 'user-a'), true)
	assert.equal(reloaded.getSnapshot('principal-a', 'user-b'), false)
	assert.equal(reloaded.getSnapshot('principal-b', 'user-a'), false)
	assert.equal(
		JSON.stringify([...backend.data.values()]).includes('budget'),
		false
	)
	reloaded.settleKnownPost('principal-a', 'user-a')
	assert.equal(first.getSnapshot('principal-a', 'user-a'), false)
})

test('unavailable persistence prevents a transition marker from being skipped', () => {
	const unavailable = new BudgetTransitionRecovery(null, true)
	assert.equal(unavailable.isStorageUnavailable('principal', 'user'), true)
	assert.equal(unavailable.getSnapshot('principal', 'user'), true)
	assert.throws(() => unavailable.markPending('principal', 'user'))
})
