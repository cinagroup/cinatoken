import type {
	ActivityBudget,
	ActivityLog,
	ActivityTimelinePoint,
} from '../../activity-contracts'

export type ActivityMetric = 'requests' | 'tokens' | 'cost' | 'latency'

export function formatActivityMoney(
	value: number | null,
	currency: string,
	locale: string,
	unknown: string
): string {
	if (value === null) return unknown
	return new Intl.NumberFormat(locale, {
		style: 'currency',
		currency,
		currencyDisplay: 'code',
		maximumFractionDigits: currency === 'USD' ? 8 : 6,
	}).format(value)
}

export function accountBudgetRemaining(budget: ActivityBudget): number | null {
	return budget.status === 'finite' ? budget.budgetRemaining : null
}

export function activityMetricValue(
	point: ActivityTimelinePoint,
	metric: ActivityMetric
): number | null {
	if (metric === 'tokens') return point.totalTokens
	if (metric === 'cost') return point.chargedCost
	if (metric === 'latency') return point.avgLatencyMs
	return point.requestCount
}

export function canOpenActivityGeneration(
	row: Pick<ActivityLog, 'id'>
): boolean {
	return /^gen-[A-Za-z0-9_-]{1,128}$/u.test(row.id)
}

export function activitySuccessRate(
	success: number,
	total: number
): number | null {
	return total === 0 ? null : success / total
}
