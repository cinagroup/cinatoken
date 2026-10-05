/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */

export type ReliabilityRollingPreset = '1h' | '1d' | '7d' | '14d' | '30d'
export type ReliabilityCalendarPreset = 'today' | 'this_week' | 'this_month'

export type ReliabilityRange =
	| { kind: 'rolling'; preset: ReliabilityRollingPreset }
	| { kind: 'calendar'; preset: ReliabilityCalendarPreset }
	| { kind: 'custom'; startUtc: string; endUtc: string }

export type ReliabilityUtcRange = { startUtc: string; endUtc: string }

export const RELIABILITY_ROLLING_PRESETS: readonly ReliabilityRollingPreset[] =
	['1h', '1d', '7d', '14d', '30d']
export const RELIABILITY_CALENDAR_PRESETS: readonly ReliabilityCalendarPreset[] =
	['today', 'this_week', 'this_month']

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_RANGE_MS = 180 * DAY_MS
const SQL_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/
const LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/

function validTimeZone(timeZone: string | null): timeZone is string {
	if (!timeZone) return false
	try {
		new Intl.DateTimeFormat('en-US', { timeZone })
		return true
	} catch {
		return false
	}
}

function sqlUtc(ms: number): string {
	return new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
}

function parseSqlUtc(value: string): number | null {
	if (!SQL_UTC_PATTERN.test(value)) return null
	const ms = Date.parse(`${value.replace(' ', 'T')}Z`)
	if (!Number.isFinite(ms) || sqlUtc(ms) !== value) return null
	return ms
}

function parseLocal(value: string): { ms: number; canonical: string } | null {
	const match = LOCAL_PATTERN.exec(value)
	if (!match) return null
	const canonical = `${value.slice(0, 16)}:${match[6] ?? '00'}`
	const ms = Date.parse(`${canonical}Z`)
	if (
		!Number.isFinite(ms) ||
		new Date(ms).toISOString().slice(0, 19) !== canonical
	)
		return null
	return { ms, canonical }
}

function zonedParts(ms: number, timeZone: string): Record<string, string> {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hourCycle: 'h23',
	}).formatToParts(ms)
	return Object.fromEntries(parts.map((part) => [part.type, part.value]))
}

function zonedLocal(ms: number, timeZone: string): string {
	const parts = zonedParts(ms, timeZone)
	return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`
}

function offsetMsAt(ms: number, timeZone: string): number | null {
	const formatter = new Intl.DateTimeFormat('en-US', {
		timeZone,
		timeZoneName: 'shortOffset',
	})
	const name = formatter
		.formatToParts(ms)
		.find((part) => part.type === 'timeZoneName')?.value
	if (name === 'GMT' || name === 'UTC') return 0
	const match = /^(?:GMT|UTC)([+-])(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?$/.exec(
		name ?? ''
	)
	if (!match) return null
	const sign = match[1] === '-' ? -1 : 1
	return (
		sign *
		(Number(match[2]) * 60 * 60 * 1000 +
			Number(match[3] ?? '0') * 60 * 1000 +
			Number(match[4] ?? '0') * 1000)
	)
}

/** Reject nonexistent or ambiguous DST wall times rather than silently moving them. */
function localToUtc(value: string, timeZone: string | null): string | null {
	const parsed = parseLocal(value)
	if (!parsed || !validTimeZone(timeZone)) return null
	const offsets = new Set<number>()
	for (let deltaHours = -36; deltaHours <= 36; deltaHours += 6) {
		const offset = offsetMsAt(parsed.ms + deltaHours * 60 * 60 * 1000, timeZone)
		if (offset === null) return null
		offsets.add(offset)
	}
	const matches = [...offsets]
		.map((offset) => parsed.ms - offset)
		.filter((candidate) => zonedLocal(candidate, timeZone) === parsed.canonical)
	return matches.length === 1 ? sqlUtc(matches[0]) : null
}

/** UTC SQL timestamp to the business zone's datetime-local input value. */
export function utcToZonedLocal(
	utcSql: string,
	timeZone: string | null
): string | null {
	const ms = parseSqlUtc(utcSql)
	if (ms === null || !validTimeZone(timeZone)) return null
	return zonedLocal(ms, timeZone).slice(0, 16)
}

function validRange(
	startUtc: string,
	endUtc: string,
	allowZero = false
): boolean {
	const startMs = parseSqlUtc(startUtc)
	const endMs = parseSqlUtc(endUtc)
	if (startMs === null || endMs === null) return false
	const duration = endMs - startMs
	return duration >= (allowZero ? 0 : 1) && duration <= MAX_RANGE_MS
}

/** The custom editor never swaps reversed endpoints or relies on server clamping. */
export function parseReliabilityCustomRange(
	startLocal: string,
	endLocal: string,
	timeZone: string | null
): ReliabilityRange | null {
	const startUtc = localToUtc(startLocal, timeZone)
	const endUtc = localToUtc(endLocal, timeZone)
	if (!startUtc || !endUtc || !validRange(startUtc, endUtc)) return null
	return { kind: 'custom', startUtc, endUtc }
}

function dateKeyDaysBefore(dateKey: string, days: number): string {
	const midnight = new Date(`${dateKey}T00:00:00Z`)
	midnight.setUTCDate(midnight.getUTCDate() - days)
	return midnight.toISOString().slice(0, 10)
}

/** `now` is supplied by the page so a render does not move the query window. */
export function resolveReliabilityRange(
	range: ReliabilityRange,
	timeZone: string | null,
	now: Date
): ReliabilityUtcRange | null {
	if (!Number.isFinite(now.getTime())) return null
	if (range.kind === 'custom')
		return validRange(range.startUtc, range.endUtc)
			? { startUtc: range.startUtc, endUtc: range.endUtc }
			: null

	const endUtc = sqlUtc(now.getTime())
	if (range.kind === 'rolling') {
		const minutes: Record<ReliabilityRollingPreset, number> = {
			'1h': 60,
			'1d': 24 * 60,
			'7d': 7 * 24 * 60,
			'14d': 14 * 24 * 60,
			'30d': 30 * 24 * 60,
		}
		const duration = minutes[range.preset]
		if (!duration) return null
		return { startUtc: sqlUtc(now.getTime() - duration * 60 * 1000), endUtc }
	}

	if (!validTimeZone(timeZone)) return null
	const localNow = zonedLocal(now.getTime(), timeZone)
	const dateKey = localNow.slice(0, 10)
	let startKey = dateKey
	if (range.preset === 'this_week') {
		const weekday = new Date(`${dateKey}T00:00:00Z`).getUTCDay()
		startKey = dateKeyDaysBefore(dateKey, (weekday + 6) % 7)
	} else if (range.preset === 'this_month') {
		startKey = `${dateKey.slice(0, 7)}-01`
	} else if (range.preset !== 'today') {
		return null
	}
	const startUtc = localToUtc(`${startKey}T00:00`, timeZone)
	return startUtc && validRange(startUtc, endUtc, true)
		? { startUtc, endUtc }
		: null
}

export function reliabilityRangePath(
	range: ReliabilityRange,
	timeZone: string | null,
	now: Date
): string | null {
	const resolved = resolveReliabilityRange(range, timeZone, now)
	if (!resolved) return null
	const params = new URLSearchParams({
		start_date: resolved.startUtc,
		end_date: resolved.endUtc,
	})
	return `/api/admin/analytics/reliability?${params.toString()}`
}
