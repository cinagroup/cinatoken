import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@/components/ui/card'
import type { ActivityData } from '../../activity-contracts'
import { ActivityBudgetCard } from './ActivityBudgetCard'
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
			<CardHeader>
				<CardDescription>{t(props.title)}</CardDescription>
				<CardTitle className='break-words tabular-nums'>
					{props.value}
				</CardTitle>
			</CardHeader>
			<CardContent>
				<div className='text-muted-foreground flex flex-col gap-1 text-xs leading-5'>
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
		<div className='flex flex-col gap-4'>
			<div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-4'>
				<SummaryCard
					title={
						budget.totalRemaining === undefined
							? 'cinatoken.account.activity.remaining'
							: 'cinatoken.account.activity.totalRemaining'
					}
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
			<ActivityBudgetCard
				budget={budget}
				currency={props.data.billingCurrency}
			/>
		</div>
	)
}
