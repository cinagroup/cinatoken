/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
	dashboardRangePath,
	defaultDashboardCustomInputs,
	parseDashboardCustomRange,
	utcMinuteToSql,
} from './dashboard-range'

test('custom inputs are exact UTC minutes and paths use server UTC SQL boundaries', () => {
	const range = parseDashboardCustomRange(
		'2026-09-27T16:00',
		'2026-09-28T00:00'
	)
	assert.deepEqual(range, {
		kind: 'custom',
		startUtc: '2026-09-27 16:00:00',
		endUtc: '2026-09-28 00:00:00',
	})
	assert.equal(
		dashboardRangePath(range!),
		'/api/admin/stats?start_date=2026-09-27+16%3A00%3A00&end_date=2026-09-28+00%3A00%3A00'
	)
	assert.equal(
		dashboardRangePath({ kind: 'preset', value: '14d' }),
		'/api/admin/stats?range=14d'
	)
})

test('invalid dates, reversed and over-180-day custom windows never reach stats', () => {
	for (const value of [
		'2026-02-30T00:00',
		'2026-09-28T25:00',
		'2026-09-28 00:00',
		'',
	])
		assert.equal(utcMinuteToSql(value), null)
	assert.equal(
		parseDashboardCustomRange('2026-09-28T00:00', '2026-09-28T00:00'),
		null
	)
	assert.equal(
		parseDashboardCustomRange('2026-09-28T01:00', '2026-09-28T00:00'),
		null
	)
	assert.equal(
		parseDashboardCustomRange('2026-01-01T00:00', '2026-09-28T00:00'),
		null
	)
	assert.throws(() =>
		dashboardRangePath({ kind: 'preset', value: 'all' as never })
	)
	assert.throws(() =>
		dashboardRangePath({
			kind: 'custom',
			startUtc: '2026-09-28 00:00:00',
			endUtc: '2026-09-28 00:00:01',
		})
	)
})

test('default custom inputs are UTC and exactly one day', () => {
	assert.deepEqual(
		defaultDashboardCustomInputs(new Date('2026-09-28T00:00:00.000Z')),
		{
			startUtc: '2026-09-27T00:00',
			endUtc: '2026-09-28T00:00',
		}
	)
})
