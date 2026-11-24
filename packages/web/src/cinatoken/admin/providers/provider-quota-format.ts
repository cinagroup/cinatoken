/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
/** Significant digits preserve small positive/negative balances instead of reporting a fabricated zero. */
export function formatProviderQuotaNumber(
	value: number | undefined,
	locale?: string
): string {
	if (value === undefined) return '—'
	const magnitude = Math.abs(value)
	return new Intl.NumberFormat(locale, {
		maximumSignificantDigits: 15,
		notation:
			magnitude !== 0 && (magnitude < 0.000001 || magnitude >= 1e15)
				? 'scientific'
				: 'standard',
	}).format(value)
}
