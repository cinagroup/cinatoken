/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseDashboardRefresh } from './dashboard-refresh'
import {
	dashboardRangeFromSearch,
	dashboardSearchFromRange,
	dashboardSearchSchema,
} from './dashboard-search'

test('legacy overview bookmarks preserve exact valid UTC bounds and moving presets', () => {
	const bounds = {
		range: '7d',
		start_date: '2026-11-20 12:00:00',
		end_date: '2026-11-27 12:00:00',
	}
	const range = dashboardRangeFromSearch(bounds)
	assert.deepEqual(range, {
		kind: 'custom',
		startUtc: bounds.start_date,
		endUtc: bounds.end_date,
	})
	assert.deepEqual(dashboardSearchFromRange(range), {
		...bounds,
		range: 'custom',
	})
	assert.deepEqual(dashboardRangeFromSearch({ range: '24h' }), {
		kind: 'rolling',
		preset: '1d',
	})
	assert.deepEqual(dashboardRangeFromSearch({ range: 'this_week' }), {
		kind: 'calendar',
		preset: 'this_week',
	})
	assert.deepEqual(
		dashboardRangeFromSearch(
			dashboardSearchFromRange({ kind: 'rolling', preset: '14d' })
		),
		{ kind: 'rolling', preset: '14d' }
	)
})
test('malformed, reversed and oversized ranges fall back to business today', () => {
	for (const search of [
		{ range: '//example.org' },
		{ start_date: '2026-02-30 00:00:00', end_date: '2026-03-05 00:00:00' },
		{ start_date: '2026-11-27 00:00:00', end_date: '2026-11-26 00:00:00' },
		{ start_date: '2025-01-01 00:00:00', end_date: '2026-11-26 00:00:00' },
		dashboardSearchSchema.parse({ range: [], start_date: {}, end_date: 77 }),
	])
		assert.deepEqual(dashboardRangeFromSearch(search), {
			kind: 'calendar',
			preset: 'today',
		})
})
test('automatic refresh needs an explicit supported interval and accepts the legacy preference', () => {
	for (const raw of [null, 'off', '-1', '1', 'Infinity', 'bogus'])
		assert.equal(parseDashboardRefresh(raw), 0)
	assert.equal(parseDashboardRefresh('30_000'), 30000)
	assert.equal(parseDashboardRefresh('300000'), 300000)
})
