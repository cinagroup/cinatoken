import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent } from '@/components/ui/card'
import type { ActivityData } from '../../activity-contracts'
import { formatAccountDate } from '../key-display'
import {
	accountBudgetRemaining,
	activitySuccessRate,
	formatActivityMoney,
} from './activity-format'

function SummaryCard(props: {
	title: string
	value: string
	children: ReactNode
}) {
	const { t } = useTranslation()
	return (
		<Card>
			<CardContent className='space-y-2 p-4'>
				<h2 className='text-muted-foreground text-xs'>{t(props.title)}</h2>
				<p className='text-xl font-semibold break-words tabular-nums'>
					{props.value}
				</p>
				<div className='text-muted-foreground space-y-1 text-xs leading-5'>
					{props.children}
				</div>
			</CardContent>
		</Card>
	)
}

export function ActivitySummary(props: { data: ActivityData }) {
	const { t, i18n } = useTranslation()
	const locale = i18n.resolvedLanguage ?? 'en'
	const number = (value: number) => new Intl.NumberFormat(locale).format(value)
	const money = (value: number | null) =>
		formatActivityMoney(
			value,
			props.data.billingCurrency,
			locale,
			t('cinatoken.account.activity.unknown')
		)
	const summary = props.data.summary
	const budget = props.data.budget
	let remaining = money(accountBudgetRemaining(budget))
	if (budget.status === 'unlimited')
		remaining = t('cinatoken.account.activity.unlimited')
	if (budget.status === 'unavailable')
		remaining = t('cinatoken.account.activity.unavailable')
	let period = budget.budgetPeriod
	if (['none', 'daily', 'weekly', 'monthly', 'annually'].includes(period))
		period = t('cinatoken.account.activity.periods.' + period)
	const rate = activitySuccessRate(summary.successCount, summary.totalRequests)
	let rateText = t('cinatoken.account.activity.noRequests')
	if (rate !== null)
		rateText = t('cinatoken.account.activity.successRate', {
			rate: new Intl.NumberFormat(locale, {
				style: 'percent',
				maximumFractionDigits: 1,
			}).format(rate),
		})
	return (
		<div className='space-y-4'>
			<div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-4'>
				<SummaryCard
					title='cinatoken.account.activity.remaining'
					value={remaining}
				>
					<p>{t('cinatoken.account.activity.accountBudget')}</p>
				</SummaryCard>
				<SummaryCard
					title='cinatoken.account.activity.requests'
					value={number(summary.totalRequests)}
				>
					<p>{rateText}</p>
					<p>
						{t('cinatoken.account.activity.requestCounts', {
							success: number(summary.successCount),
							errors: number(summary.errorCount),
						})}
					</p>
				</SummaryCard>
				<SummaryCard
					title='cinatoken.account.activity.tokens'
					value={number(summary.totalTokens)}
				>
					<p>
						{t('cinatoken.account.activity.inputOutput', {
							input: number(summary.inputTokens),
							output: number(summary.outputTokens),
						})}
					</p>
					<p>
						{t('cinatoken.account.activity.cacheTokens', {
							read: number(summary.cacheReadTokens),
							write: number(summary.cacheWriteTokens),
						})}
					</p>
				</SummaryCard>
				<SummaryCard
					title='cinatoken.account.activity.cost'
					value={money(summary.chargedCost)}
				>
					<p>
						{t('cinatoken.account.activity.metered')}:{' '}
						{money(summary.meteredCost)}
					</p>
					<p>
						{t('cinatoken.account.activity.standard')}:{' '}
						{money(summary.standardCost)}
					</p>
					<p>
						{summary.avgLatencyMs === null
							? t('cinatoken.account.activity.unknown')
							: t('cinatoken.account.activity.averageLatency', {
									value: number(Math.round(summary.avgLatencyMs)),
								})}
					</p>
				</SummaryCard>
			</div>
			<Card>
				<CardContent className='space-y-3 p-4'>
					<div>
						<h2 className='font-medium'>
							{t('cinatoken.account.activity.accountBudget')}
						</h2>
						<p className='text-muted-foreground mt-1 text-xs'>
							{t('cinatoken.account.activity.budgetHint')}
						</p>
					</div>
					<dl className='grid gap-3 sm:grid-cols-3 xl:grid-cols-6'>
						{[
							{
								key: 'max',
								value:
									budget.status === 'unlimited'
										? t('cinatoken.account.activity.unlimited')
										: money(budget.budgetMax),
							},
							{ key: 'base', value: money(budget.budgetBase) },
							{ key: 'spent', value: money(budget.budgetSpent) },
							{ key: 'reserved', value: money(budget.budgetReserved) },
							{
								key: 'period',
								value: period || t('cinatoken.account.activity.unknown'),
							},
							{
								key: 'resetAt',
								value: budget.budgetResetAt
									? formatAccountDate(budget.budgetResetAt, locale)
									: t('cinatoken.account.activity.unknown'),
							},
						].map((item) => (
							<div key={item.key}>
								<dt className='text-muted-foreground text-xs'>
									{t('cinatoken.account.activity.' + item.key)}
								</dt>
								<dd className='mt-1 text-sm break-words tabular-nums'>
									{item.value}
								</dd>
							</div>
						))}
					</dl>
				</CardContent>
			</Card>
		</div>
	)
}
