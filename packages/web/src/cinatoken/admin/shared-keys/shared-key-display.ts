/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
export function formatSharedKeyNumber(value: number, locale: string): string {
	return new Intl.NumberFormat(locale, { maximumSignificantDigits: 15 }).format(
		value
	)
}
export function formatSharedKeyEarnings(value: number, locale: string): string {
	return new Intl.NumberFormat(locale, {
		style: 'currency',
		currency: 'USD',
		currencyDisplay: 'code',
		maximumFractionDigits: 8,
	}).format(value)
}
export function formatSharedKeyTime(
	value: string | null,
	locale: string
): string {
	if (value === null) return '—'
	return new Intl.DateTimeFormat(locale, {
		dateStyle: 'medium',
		timeStyle: 'medium',
		timeZone: 'UTC',
	}).format(new Date(value))
}
