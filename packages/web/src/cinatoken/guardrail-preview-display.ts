/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'

/** Preview values are already in their labelled units; never scale or round a nonzero value to zero. */
export function formatGuardrailPreviewNumber(
	value: number | null,
	locale: string,
	unknown: string
): string {
	if (value === null || !Number.isFinite(value)) return unknown
	const magnitude = Math.abs(value)
	return new Intl.NumberFormat(locale, {
		maximumSignificantDigits: Number.isSafeInteger(value) ? 16 : 15,
		notation:
			magnitude !== 0 && (magnitude < 0.000001 || magnitude >= 1e15)
				? 'scientific'
				: 'standard',
	}).format(value)
}

const instant = z.iso.datetime({ offset: true })
const sqlUtc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/u

export function formatGuardrailPreviewTime(
	value: string,
	timezone: string,
	locale: string
): { time: string | null; timezone: string; usedFallback: boolean } {
	let zone = timezone
	let usedFallback = false
	try {
		new Intl.DateTimeFormat(locale, { timeZone: zone })
	} catch {
		zone = 'UTC'
		usedFallback = true
	}
	const normalized = sqlUtc.test(value) ? value.replace(' ', 'T') + 'Z' : value
	if (!instant.safeParse(normalized).success)
		return { time: null, timezone: zone, usedFallback }
	const ms = Date.parse(normalized)
	if (!Number.isFinite(ms)) return { time: null, timezone: zone, usedFallback }
	return {
		time: new Intl.DateTimeFormat(locale, {
			timeZone: zone,
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			timeZoneName: 'shortOffset',
		}).format(new Date(ms)),
		timezone: zone,
		usedFallback,
	}
}
