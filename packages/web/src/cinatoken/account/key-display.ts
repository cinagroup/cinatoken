import type { GatewayKey } from '../contracts'

export function keyStatus(
	key: Pick<GatewayKey, 'status' | 'expiresAt'>,
	now: number
): string {
	if (
		key.status === 'active' &&
		key.expiresAt &&
		parseAccountTimestamp(key.expiresAt) <= now
	)
		return 'expired'
	return key.status
}

function parseAccountTimestamp(value: string): number {
	// The database also emits UTC timestamps without an explicit timezone.
	const normalized = /(?:Z|[+-]\d\d:\d\d)$/i.test(value)
		? value
		: `${value.replace(' ', 'T')}Z`
	return Date.parse(normalized)
}

export function formatAccountDate(value: string, locale: string): string {
	const date = new Date(parseAccountTimestamp(value))
	if (!Number.isFinite(date.getTime())) return '—'
	return new Intl.DateTimeFormat(locale, {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(date)
}

export function formatKeyLimit(
	value: number,
	locale: string,
	currency: string
): string {
	return new Intl.NumberFormat(locale, {
		style: 'currency',
		currency,
		currencyDisplay: 'code',
		maximumFractionDigits: 6,
	}).format(value)
}
