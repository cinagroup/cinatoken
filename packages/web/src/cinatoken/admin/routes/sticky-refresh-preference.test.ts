/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseStickyRefreshInterval } from './sticky-refresh-preference'

test('sticky refresh preference preserves legacy values but bounds forged timers', () => {
	for (const [raw, expected] of [
		['60000', 60000],
		['60_000', 60000],
		['300000', 300000],
		['300_000', 300000],
		['600000', 600000],
		['600_000', 600000],
	] as const)
		assert.equal(parseStickyRefreshInterval(raw), expected)
	for (const raw of [
		null,
		'off',
		'0',
		'1',
		'-60000',
		'Infinity',
		'60000.1',
		'60000\n',
		'6000000',
		'token',
	])
		assert.equal(parseStickyRefreshInterval(raw), 0)
})
