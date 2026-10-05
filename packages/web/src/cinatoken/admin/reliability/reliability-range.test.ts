/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
	parseReliabilityCustomRange,
	reliabilityRangePath,
	resolveReliabilityRange,
	utcToZonedLocal,
	type ReliabilityRange,
} from './reliability-range'

const singapore = 'Asia/Singapore'

test('five rolling presets use fixed elapsed durations and injected now', () => {
	const now = new Date('2026-09-28T02:30:42.777Z')
	const expected = {
		'1h': '2026-09-28 01:30:42',
		'1d': '2026-09-27 02:30:42',
		'7d': '2026-09-21 02:30:42',
		'14d': '2026-09-14 02:30:42',
		'30d': '2026-08-29 02:30:42',
	} as const
	for (const [preset, startUtc] of Object.entries(expected)) {
		const range = {
			kind: 'rolling',
			preset,
		} as ReliabilityRange
		assert.deepEqual(resolveReliabilityRange(range, singapore, now), {
			startUtc,
			endUtc: '2026-09-28 02:30:42',
		})
	}
})

test('today, Monday week, and month start use the configured business zone', () => {
	const now = new Date('2026-09-27T16:30:00Z') // Monday 00:30 in Singapore
	const presets = {
		today: '2026-09-27 16:00:00',
		this_week: '2026-09-27 16:00:00',
		this_month: '2026-08-31 16:00:00',
	} as const
	for (const [preset, startUtc] of Object.entries(presets)) {
		assert.deepEqual(
			resolveReliabilityRange(
				{ kind: 'calendar', preset } as ReliabilityRange,
				singapore,
				now
			),
			{ startUtc, endUtc: '2026-09-27 16:30:00' }
		)
	}
})

test('business calendar windows reflect the 23-hour and 25-hour DST days', () => {
	const zone = 'America/New_York'
	assert.deepEqual(
		resolveReliabilityRange(
			{ kind: 'calendar', preset: 'today' },
			zone,
			new Date('2026-03-08T16:00:00Z')
		),
		{ startUtc: '2026-03-08 05:00:00', endUtc: '2026-03-08 16:00:00' }
	)
	assert.deepEqual(
		resolveReliabilityRange(
			{ kind: 'calendar', preset: 'today' },
			zone,
			new Date('2026-11-02T04:30:00Z')
		),
		{ startUtc: '2026-11-01 04:00:00', endUtc: '2026-11-02 04:30:00' }
	)
})

test('custom datetime-local uses business zone rather than browser-local time', () => {
	const range = parseReliabilityCustomRange(
		'2026-09-28T10:30',
		'2026-09-28T11:30',
		singapore
	)
	assert.deepEqual(range, {
		kind: 'custom',
		startUtc: '2026-09-28 02:30:00',
		endUtc: '2026-09-28 03:30:00',
	})
	assert.equal(
		utcToZonedLocal('2026-09-28 02:30:00', singapore),
		'2026-09-28T10:30'
	)
	assert.deepEqual(
		resolveReliabilityRange(
			range!,
			singapore,
			new Date('2030-01-01T00:00:00Z')
		),
		{ startUtc: '2026-09-28 02:30:00', endUtc: '2026-09-28 03:30:00' }
	)
	const path = reliabilityRangePath(
		range!,
		singapore,
		new Date('2030-01-01T00:00:00Z')
	)
	assert.ok(path)
	const url = new URL(path, 'https://example.test')
	assert.equal(url.pathname, '/api/admin/analytics/reliability')
	assert.equal(url.searchParams.get('start_date'), '2026-09-28 02:30:00')
	assert.equal(url.searchParams.get('end_date'), '2026-09-28 03:30:00')
})

test('DST gaps and repeated wall times are rejected rather than shifted or guessed', () => {
	const zone = 'America/New_York'
	assert.equal(
		parseReliabilityCustomRange('2026-03-08T02:30', '2026-03-08T03:30', zone),
		null
	)
	assert.equal(
		parseReliabilityCustomRange('2026-11-01T01:30', '2026-11-01T02:30', zone),
		null
	)
	assert.deepEqual(
		parseReliabilityCustomRange('2026-03-08T01:30', '2026-03-08T03:30', zone),
		{
			kind: 'custom',
			startUtc: '2026-03-08 06:30:00',
			endUtc: '2026-03-08 07:30:00',
		}
	)
	assert.equal(utcToZonedLocal('2026-11-01 05:30:00', zone), '2026-11-01T01:30')
})

test('custom range rejects reversal, equality, malformed values and server-clamped duration', () => {
	for (const [start, end] of [
		['2026-09-28T11:00', '2026-09-28T10:00'],
		['2026-09-28T10:00', '2026-09-28T10:00'],
		['2026-02-30T10:00', '2026-03-01T10:00'],
		['2026-09-28T25:00', '2026-09-29T00:00'],
		['2026-01-01T00:00', '2026-07-01T00:01'],
	])
		assert.equal(parseReliabilityCustomRange(start, end, 'UTC'), null)
	assert.deepEqual(
		parseReliabilityCustomRange('2026-01-01T00:00', '2026-06-30T00:00', 'UTC'),
		{
			kind: 'custom',
			startUtc: '2026-01-01 00:00:00',
			endUtc: '2026-06-30 00:00:00',
		}
	)
	assert.equal(
		resolveReliabilityRange(
			{
				kind: 'custom',
				startUtc: '2026-02-30 00:00:00',
				endUtc: '2026-03-01 00:00:00',
			},
			'UTC',
			new Date('2026-03-01T00:00:00Z')
		),
		null
	)
})

test('unconfirmed or invalid timezone and invalid clock fail closed', () => {
	const today: ReliabilityRange = { kind: 'calendar', preset: 'today' }
	assert.equal(resolveReliabilityRange(today, null, new Date()), null)
	assert.equal(resolveReliabilityRange(today, 'Mars/Olympus', new Date()), null)
	assert.equal(resolveReliabilityRange(today, 'UTC', new Date('invalid')), null)
	assert.equal(reliabilityRangePath(today, null, new Date()), null)
	assert.equal(utcToZonedLocal('2026-02-30 00:00:00', singapore), null)
	assert.equal(utcToZonedLocal('2026-09-28 00:00:00', null), null)
	assert.equal(
		parseReliabilityCustomRange('2026-09-28T10:00', '2026-09-28T11:00', null),
		null
	)
	assert.deepEqual(
		resolveReliabilityRange(
			{ kind: 'rolling', preset: '1h' },
			null,
			new Date('2026-09-28T02:30:00Z')
		),
		{ startUtc: '2026-09-28 01:30:00', endUtc: '2026-09-28 02:30:00' }
	)
})
