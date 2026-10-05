/** Repository DTOs already use major units. Never divide them by one million again. */
export function formatEarningsMoney(
	value: number,
	currency: string,
	locale: string
): string {
	return new Intl.NumberFormat(locale, {
		style: 'currency',
		currency,
		currencyDisplay: 'code',
		minimumFractionDigits: 2,
		maximumFractionDigits: 6,
	}).format(value)
}

export function earningsPageCount(total: number, pageSize = 20): number {
	return Math.max(1, Math.ceil(total / pageSize))
}
