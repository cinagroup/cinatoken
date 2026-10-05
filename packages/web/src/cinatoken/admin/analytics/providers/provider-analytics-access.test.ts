/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
	modelAnalyticsAccessKey,
	modelAnalyticsAccessRecovery,
} from '../models/model-analytics-access'

test('a provider analytics denial stays bounded to principal and permission domain across rechecks', () => {
	const api = {}
	const access = modelAnalyticsAccessRecovery(api)
	const first = `providerAnalytics:${modelAnalyticsAccessKey(
		JSON.stringify(['user-1', 'subject-1', 1])
	)}`
	const rechecked = `providerAnalytics:${modelAnalyticsAccessKey(
		JSON.stringify(['user-1', 'subject-1', 2])
	)}`
	const other = `providerAnalytics:${modelAnalyticsAccessKey(
		JSON.stringify(['user-2', 'subject-2', 1])
	)}`
	assert.equal(first, rechecked)
	assert.equal(access.block(first, 'analytics'), true)
	assert.equal(access.block(rechecked, 'analytics'), false)
	assert.equal(access.getSnapshot(first, 'analytics'), true)
	assert.equal(access.getSnapshot(first, 'display'), false)
	assert.equal(access.getSnapshot(first, 'logs'), false)
	assert.equal(access.getSnapshot(other, 'analytics'), false)
	access.settle(first, 'analytics')
	assert.equal(access.getSnapshot(first, 'analytics'), false)
})
