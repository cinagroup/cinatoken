/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
	formatGuardrailPreviewNumber as number,
	formatGuardrailPreviewTime as time,
} from './guardrail-preview-display'

test('preview distinguishes unavailable, zero and tiny nonzero values without rescaling units', () => {
	assert.equal(number(null, 'en', 'Unknown'), 'Unknown')
	assert.equal(number(NaN, 'en', 'Unknown'), 'Unknown')
	assert.equal(number(Infinity, 'en', 'Unknown'), 'Unknown')
	assert.equal(number(0, 'en', 'Unknown'), '0')
	assert.equal(number(1e-12, 'en', 'Unknown'), '1E-12')
	assert.equal(number(0.000001, 'en', 'Unknown'), '0.000001')
	assert.match(number(Number.MIN_VALUE, 'en', 'Unknown'), /E-324$/u)
})

test('preview retains price detail while suppressing binary tails and bounding large numeric labels', () => {
	assert.equal(number(1.23456789, 'en', '?'), '1.23456789')
	assert.equal(number(0.1 + 0.2, 'en', '?'), '0.3')
	assert.equal(number(1.23e15, 'en', '?'), '1.23E15')
	assert.equal(number(123456, 'en', '?'), '123,456')
	assert.equal(
		number(Number.MAX_SAFE_INTEGER, 'en', '?'),
		'9.007199254740991E15'
	)
})

test('all four preview locales retain nonzero prices and a localized unavailable label', () => {
	for (const locale of ['en', 'zh', 'ja', 'ko']) {
		assert.notEqual(
			number(1e-15, locale, 'Unavailable'),
			number(0, locale, 'Unavailable')
		)
		assert.match(number(1e-15, locale, 'Unavailable'), /E-15$/u)
		assert.equal(number(null, locale, 'Unavailable'), 'Unavailable')
	}
})

test('evaluation times use the evidence timezone across dates and both daylight-saving folds', () => {
	const singapore = time('2026-09-28T00:00:00Z', 'Asia/Singapore', 'en')
	assert.match(singapore.time!, /Sep 28, 2026.*08:00:00.*GMT\+8/u)
	assert.equal(singapore.usedFallback, false)
	assert.match(
		time('2026-09-28T00:00:00Z', 'America/Los_Angeles', 'en').time!,
		/Sep 27, 2026.*05:00:00.*GMT-7/u
	)
	assert.match(
		time('2026-11-01T05:30:00Z', 'America/New_York', 'en').time!,
		/01:30:00.*GMT-4/u
	)
	assert.match(
		time('2026-11-01T06:30:00Z', 'America/New_York', 'en').time!,
		/01:30:00.*GMT-5/u
	)
})

test('explicit offsets and historical SQL UTC instants do not inherit the browser timezone', () => {
	const utc = time('2026-09-28T00:00:00Z', 'Asia/Singapore', 'en')
	assert.deepEqual(
		time('2026-09-28T08:00:00+08:00', 'Asia/Singapore', 'en'),
		utc
	)
	assert.deepEqual(
		time('2026-09-28 00:00:00.000000', 'Asia/Singapore', 'en'),
		utc
	)
})

test('invalid zones explicitly fall back to UTC and ambiguous or impossible times remain unavailable', () => {
	const fallback = time('2026-09-28T00:00:00Z', 'Invalid/Zone', 'en')
	assert.equal(fallback.timezone, 'UTC')
	assert.equal(fallback.usedFallback, true)
	assert.match(fallback.time!, /12:00:00.*GMT/u)
	for (const value of ['2026-02-30T00:00:00Z', '2026-09-28T00:00:00', 'bad'])
		assert.equal(time(value, 'UTC', 'en').time, null)
})
