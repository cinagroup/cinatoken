/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
	modelAnalyticsAccessKey,
	modelAnalyticsAccessRecovery,
} from '../models/model-analytics-access'

test('user analytics denial survives access-version recheck but does not cross principals or permissions', () => {
	const access = modelAnalyticsAccessRecovery({})
	const original = `userAnalytics:${modelAnalyticsAccessKey(
		JSON.stringify(['user-1', 'subject-1', 1])
	)}`
	const rechecked = `userAnalytics:${modelAnalyticsAccessKey(
		JSON.stringify(['user-1', 'subject-1', 2])
	)}`
	const other = `userAnalytics:${modelAnalyticsAccessKey(
		JSON.stringify(['user-2', 'subject-2', 1])
	)}`
	assert.equal(original, rechecked)
	assert.equal(access.block(original, 'analytics'), true)
	assert.equal(access.block(rechecked, 'analytics'), false)
	assert.equal(access.getSnapshot(original, 'analytics'), true)
	assert.equal(access.getSnapshot(original, 'display'), false)
	assert.equal(access.getSnapshot(original, 'logs'), false)
	assert.equal(access.getSnapshot(other, 'analytics'), false)
	access.settle(original, 'analytics')
	assert.equal(access.getSnapshot(original, 'analytics'), false)
})
