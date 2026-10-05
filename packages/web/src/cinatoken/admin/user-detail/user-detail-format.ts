/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
export function formatUserDetailTime(
	value: string | null | undefined,
	locale: string,
	timezone: string | null
): string {
	if (!value) return '—'
	const zone = timezone ?? 'UTC'
	return (
		new Intl.DateTimeFormat(locale, {
			timeZone: zone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hourCycle: 'h23',
		}).format(new Date(value)) + ` ${zone}`
	)
}

export function formatUserDetailMoney(
	value: number | null | undefined,
	currency: 'USD' | 'CNY' | null,
	locale: string
): string {
	if (currency === null || value === null || value === undefined) return '—'
	return new Intl.NumberFormat(locale, {
		style: 'currency',
		currency,
		minimumFractionDigits: 2,
		maximumFractionDigits: 6,
	}).format(value)
}
