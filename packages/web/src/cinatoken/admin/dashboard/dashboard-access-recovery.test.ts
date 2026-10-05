/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
	dashboardAccessIdentityKey,
	dashboardAccessRecovery,
} from './dashboard-access-recovery'

test('403 closes dashboard across Console access-version and portal-epoch rechecks', () => {
	const api = {}
	const before = dashboardAccessIdentityKey(
		JSON.stringify(['user:a', 'cinaauth:a', 1])
	)
	const after = dashboardAccessIdentityKey(
		JSON.stringify(['user:a', 'cinaauth:a', 2])
	)
	assert.equal(before, after)
	const firstMount = dashboardAccessRecovery(api)
	assert.equal(firstMount.block(before), true)
	const secondMount = dashboardAccessRecovery(api)
	assert.equal(secondMount.getSnapshot(after), true)
	for (let attempt = 0; attempt < 100; attempt++)
		assert.equal(secondMount.block(after), false)
	assert.equal(secondMount.getSnapshot(after), true)
	assert.equal(
		secondMount.getSnapshot(
			dashboardAccessIdentityKey(JSON.stringify(['user:b', 'cinaauth:b', 2]))
		),
		false
	)
	secondMount.settle(after)
	assert.equal(secondMount.block(after), true)
})
