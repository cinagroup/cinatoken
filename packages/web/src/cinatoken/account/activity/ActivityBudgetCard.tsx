/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from '@/components/ui/card'
import type { ActivityBudget } from '../../activity-contracts'
import { formatAccountDate } from '../key-display'
import { formatActivityMoney } from './activity-format'

function BudgetValues(props: {
	items: Array<{ label: string; value: string }>
}) {
	return (
		<dl className='grid gap-4 sm:grid-cols-2'>
			{props.items.map((item) => (
				<div key={item.label} className='min-w-0'>
					<dt className='text-muted-foreground text-xs'>{item.label}</dt>
					<dd className='mt-1 text-sm break-words tabular-nums'>
						{item.value}
					</dd>
				</div>
			))}
		</dl>
	)
}

export function ActivityBudgetCard(props: {
	budget: ActivityBudget
	currency: string
}) {
	const { t, i18n } = useTranslation()
	const locale = i18n.resolvedLanguage ?? 'en'
	const budget = props.budget
	const unknown = t('cinatoken.account.activity.unknown')
	const money = (value: number | null | undefined) =>
		formatActivityMoney(value ?? null, props.currency, locale, unknown)
	const hasWallet = budget.walletGranted !== undefined
	let period = budget.budgetPeriod
	if (['none', 'daily', 'weekly', 'monthly', 'annually'].includes(period))
		period = t('cinatoken.account.activity.periods.' + period)
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<h2>{t('cinatoken.account.activity.accountBudget')}</h2>
				</CardTitle>
				<CardDescription>
					{t('cinatoken.account.activity.budgetHint')}
				</CardDescription>
			</CardHeader>
			<CardContent className='grid gap-6 md:grid-cols-2'>
				<section
					aria-label={t('cinatoken.account.activity.periodBudget')}
					className='flex flex-col gap-4'
				>
					<h3 className='font-medium'>
						{t('cinatoken.account.activity.periodBudget')}
					</h3>
					<BudgetValues
						items={[
							{
								label: t('cinatoken.account.activity.max'),
								value:
									budget.status === 'unlimited'
										? t('cinatoken.account.activity.unlimited')
										: money(budget.budgetMax),
							},
							{
								label: t('cinatoken.account.activity.base'),
								value: money(budget.budgetBase),
							},
							{
								label: t('cinatoken.account.activity.spent'),
								value: money(budget.budgetSpent),
							},
							{
								label: t('cinatoken.account.activity.period'),
								value: period || unknown,
							},
							{
								label: t('cinatoken.account.activity.resetAt'),
								value: budget.budgetResetAt
									? formatAccountDate(budget.budgetResetAt, locale)
									: unknown,
							},
						]}
					/>
				</section>
				{hasWallet ? (
					<section
						aria-label={t('cinatoken.account.activity.permanentBudget')}
						className='flex flex-col gap-4'
					>
						<div className='flex flex-wrap items-center gap-2'>
							<h3 className='font-medium'>
								{t('cinatoken.account.activity.permanentBudget')}
							</h3>
							<Badge variant='secondary'>
								{t('cinatoken.account.activity.walletDoesNotReset')}
							</Badge>
						</div>
						<BudgetValues
							items={[
								{
									label: t('cinatoken.account.activity.walletGranted'),
									value: money(budget.walletGranted),
								},
								{
									label: t('cinatoken.account.activity.walletSpent'),
									value: money(budget.walletSpent),
								},
								{
									label: t('cinatoken.account.activity.walletRemaining'),
									value: money(budget.walletRemaining),
								},
							]}
						/>
					</section>
				) : (
					<Alert>
						<AlertDescription>
							{t('cinatoken.account.activity.walletUnavailable')}
						</AlertDescription>
					</Alert>
				)}
			</CardContent>
			<CardFooter className='flex flex-col items-start gap-2'>
				<dl className='flex flex-wrap items-baseline gap-2 text-sm'>
					<dt className='text-muted-foreground'>
						{t('cinatoken.account.activity.reserved')}
					</dt>
					<dd className='tabular-nums'>{money(budget.budgetReserved)}</dd>
				</dl>
				{hasWallet && (
					<p className='text-muted-foreground text-xs leading-5'>
						{t('cinatoken.account.activity.totalBudgetHint')}
					</p>
				)}
			</CardFooter>
		</Card>
	)
}
