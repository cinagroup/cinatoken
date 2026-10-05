/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { DashboardDisplayConfig } from './dashboard-contracts'

export function formatNumber(value: number, locale: string): string {
	return new Intl.NumberFormat(locale).format(value)
}

export function formatCompact(value: number, locale: string): string {
	return new Intl.NumberFormat(locale, {
		notation: 'compact',
		maximumFractionDigits: 1,
	}).format(value)
}

export function formatMoney(
	value: number,
	currency: DashboardDisplayConfig['billingCurrency'],
	locale: string
): string {
	return new Intl.NumberFormat(locale, {
		style: 'currency',
		currency,
		minimumFractionDigits: 2,
		maximumFractionDigits: 4,
	}).format(value)
}

export function formatTime(
	value: string,
	timezone: string,
	locale: string
): string {
	return new Intl.DateTimeFormat(locale, {
		timeZone: timezone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
	}).format(new Date(value))
}

export function bucketTime(value: string): string {
	return value.includes(' ')
		? value.replace(' ', 'T') + 'Z'
		: value + 'T00:00:00Z'
}
