/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
	bucketCoordinate,
	bucketLabel,
	trendGeometry,
	type TrendRow,
} from './dashboard-trend'

const row = (bucket: string, overrides: Partial<TrendRow> = {}): TrendRow => ({
	bucket,
	request_count: 10,
	input_tokens: 100,
	output_tokens: 20,
	cache_read_tokens: 80,
	cache_write_tokens: 0,
	total_tokens: 120,
	charged_cost: 2,
	avg_latency_ms: 150,
	cache_hit_rate: 80,
	...overrides,
})
test('wall labels remain unchanged; impossible dates rejected', () => {
	assert.equal(bucketLabel('2026-10-23 07:00:00'), '2026-10-23 07:00')
	assert.equal(bucketLabel('2026-10-23'), '2026-10-23')
	assert.ok(Number.isNaN(bucketCoordinate('2026-02-30')))
})
test('four metrics include cache reads', () => {
	const rows = [row('2026-10-23 01:00:00')]
	assert.deepEqual(
		trendGeometry(rows, 'tokens', 'hour', 500).paths.map((p) => p.field),
		['input_tokens', 'output_tokens', 'cache_read_tokens']
	)
	assert.equal(trendGeometry(rows, 'requests', 'hour', 500).max, 10)
	assert.equal(trendGeometry(rows, 'cost', 'hour', 500).max, 2)
	assert.equal(trendGeometry(rows, 'latency', 'hour', 500).max, 150)
})
test('null latency and missing hours split paths and keep point markers', () => {
	const rows = [
		row('2026-10-23 01:00:00'),
		row('2026-10-23 02:00:00', { avg_latency_ms: null }),
		row('2026-10-23 03:00:00'),
		row('2026-10-23 06:00:00'),
	]
	const g = trendGeometry(rows, 'latency', 'hour', 320)
	assert.equal(g.paths[0]!.segments.length, 3)
	assert.equal(g.paths[0]!.points.length, 3)
	assert.equal(
		g.paths[0]!.segments.some((d) => d.includes('L')),
		false
	)
})
test('negative costs retain zero reference; empty/null series invent no samples', () => {
	const g = trendGeometry(
		[row('2026-10-23', { charged_cost: -3 })],
		'cost',
		'day',
		320
	)
	assert.equal(g.min, -3)
	assert.equal(g.max, 0)
	assert.equal(g.paths[0]!.points[0]!.y, g.bottom)
	assert.equal(
		trendGeometry([], 'requests', 'hour', 320).paths[0]!.points.length,
		0
	)
	assert.equal(
		trendGeometry(
			[row('2026-10-23', { avg_latency_ms: null })],
			'latency',
			'day',
			320
		).paths[0]!.segments.length,
		0
	)
})
test('time coordinates preserve spacing and ordering without input mutation', () => {
	const rows = [
		row('2026-10-23 04:00:00'),
		row('2026-10-23 01:00:00'),
		row('2026-10-23 02:00:00'),
	]
	const g = trendGeometry(rows, 'requests', 'hour', 600)
	const [a, b, c] = g.paths[0]!.points
	assert.ok(Math.abs((b!.x - a!.x) / (c!.x - a!.x) - 1 / 3) < 1e-9)
	assert.equal(rows[0]!.bucket, '2026-10-23 04:00:00')
})
