/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { DashboardStats } from './dashboard-contracts'

export type TrendView = 'requests' | 'tokens' | 'cost' | 'latency'
export type TrendRow = DashboardStats['timeseries'][number]
export const trendSeries = {
	requests: [
		{
			field: 'request_count',
			label: 'requests',
			color: '#2563eb',
			dash: undefined,
		},
	],
	tokens: [
		{
			field: 'input_tokens',
			label: 'inputTokens',
			color: '#2563eb',
			dash: undefined,
		},
		{
			field: 'output_tokens',
			label: 'outputTokens',
			color: '#a855f7',
			dash: '6 3',
		},
		{
			field: 'cache_read_tokens',
			label: 'cacheRead',
			color: '#0d9488',
			dash: '2 3',
		},
	],
	cost: [
		{ field: 'charged_cost', label: 'cost', color: '#2563eb', dash: undefined },
	],
	latency: [
		{
			field: 'avg_latency_ms',
			label: 'latency',
			color: '#2563eb',
			dash: undefined,
		},
	],
} as const

/** Synthetic wall-clock coordinates only: buckets are already in the business zone. */
export function bucketCoordinate(value: string): number {
	const canonical =
		value.length === 10 ? `${value}T00:00:00` : value.replace(' ', 'T')
	const date = new Date(`${canonical}Z`)
	if (
		!Number.isFinite(date.getTime()) ||
		date.toISOString().slice(0, 19) !== canonical
	)
		return NaN
	return date.getTime()
}
export function bucketLabel(value: string): string {
	return value.length === 10 ? value : value.slice(0, 16)
}
export function trendGeometry(
	rows: readonly TrendRow[],
	view: TrendView,
	granularity: 'hour' | 'day',
	width: number
) {
	const ordered = [...rows].sort(
		(a, b) => bucketCoordinate(a.bucket) - bucketCoordinate(b.bucket)
	)
	const series = trendSeries[view]
	const values = ordered.flatMap((row) =>
		series.flatMap((s) =>
			row[s.field] === null ? [] : [row[s.field] as number]
		)
	)
	const min = Math.min(0, ...values),
		max = Math.max(0, ...values)
	const upper = max === min ? min + 1 : max
	const left = 54,
		right = Math.max(100, width - 14),
		top = 12,
		bottom = 170
	const start = bucketCoordinate(ordered[0]?.bucket ?? ''),
		end = bucketCoordinate(ordered.at(-1)?.bucket ?? '')
	const x = (row: TrendRow): number =>
		start === end
			? (left + right) / 2
			: left +
				((bucketCoordinate(row.bucket) - start) / (end - start)) *
					(right - left)
	const y = (value: number): number =>
		bottom - ((value - min) / (upper - min)) * (bottom - top)
	const interval = granularity === 'hour' ? 3600000 : 86400000
	const paths = series.map((s) => {
		let previous: number | null = null
		const points: { x: number; y: number; bucket: string }[] = []
		const segments: string[] = []
		let segment = ''
		for (const row of ordered) {
			const value = row[s.field],
				coordinate = bucketCoordinate(row.bucket)
			if (
				value === null ||
				(previous !== null && coordinate - previous > interval)
			) {
				if (segment) segments.push(segment)
				segment = ''
			}
			if (value !== null) {
				const point = { x: x(row), y: y(value), bucket: row.bucket }
				points.push(point)
				segment += `${segment ? ' L' : 'M'}${point.x},${point.y}`
			}
			previous = coordinate
		}
		if (segment) segments.push(segment)
		return { ...s, points, segments }
	})
	return {
		rows: ordered,
		paths,
		left,
		right,
		top,
		bottom,
		min,
		max: upper,
		x,
		y,
	}
}
