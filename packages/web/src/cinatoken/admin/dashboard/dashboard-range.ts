/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'

export const dashboardPresetSchema = z.enum(['1h', '1d', '7d', '14d', '30d'])
export type DashboardPreset = z.infer<typeof dashboardPresetSchema>
export type DashboardRange =
	| { kind: 'preset'; value: DashboardPreset }
	| { kind: 'custom'; startUtc: string; endUtc: string }

const utcMinutePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/
const MAX_CUSTOM_RANGE_MS = 180 * 24 * 60 * 60 * 1000

export function utcMinuteToSql(value: string): string | null {
	if (!utcMinutePattern.test(value)) return null
	const date = new Date(value + ':00Z')
	if (!Number.isFinite(date.getTime())) return null
	if (date.toISOString().slice(0, 16) !== value) return null
	return date.toISOString().slice(0, 19).replace('T', ' ')
}

export function parseDashboardCustomRange(
	startUtc: string,
	endUtc: string
): DashboardRange | null {
	const start = utcMinuteToSql(startUtc)
	const end = utcMinuteToSql(endUtc)
	if (!start || !end) return null
	const duration =
		Date.parse(end.replace(' ', 'T') + 'Z') -
		Date.parse(start.replace(' ', 'T') + 'Z')
	if (duration <= 0 || duration > MAX_CUSTOM_RANGE_MS) return null
	return { kind: 'custom', startUtc: start, endUtc: end }
}

/** Only exact allowlisted relative ranges or validated absolute UTC windows reach the API. */
export function dashboardRangePath(range: DashboardRange): string {
	const params = new URLSearchParams()
	if (range.kind === 'preset') {
		params.set('range', dashboardPresetSchema.parse(range.value))
	} else {
		const startInput = range.startUtc.replace(' ', 'T').slice(0, 16)
		const endInput = range.endUtc.replace(' ', 'T').slice(0, 16)
		const checked = parseDashboardCustomRange(startInput, endInput)
		if (
			!checked ||
			checked.kind !== 'custom' ||
			checked.startUtc !== range.startUtc ||
			checked.endUtc !== range.endUtc
		)
			throw new TypeError('Invalid dashboard UTC range')
		params.set('start_date', checked.startUtc)
		params.set('end_date', checked.endUtc)
	}
	return `/api/admin/stats?${params.toString()}`
}

export function defaultDashboardCustomInputs(now = new Date()): {
	startUtc: string
	endUtc: string
} {
	const endUtc = now.toISOString().slice(0, 16)
	const startUtc = new Date(now.getTime() - 24 * 60 * 60 * 1000)
		.toISOString()
		.slice(0, 16)
	return { startUtc, endUtc }
}
