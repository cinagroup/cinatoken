import { useTranslation } from 'react-i18next'
import { Card, CardContent } from '@/components/ui/card'
import type { ActivityData, ActivityGroup } from '../../activity-contracts'
import type { ActivityFilterForm } from './activity-filter-schema'
import { activitySuccessRate, formatActivityMoney } from './activity-format'

function BreakdownList(props: {
	groups: ActivityGroup[]
	currency: string
	title: string
	disabled: boolean
	maxIdLength: number
	onSelect: (id: string) => void
}) {
	const { t, i18n } = useTranslation()
	const locale = i18n.resolvedLanguage ?? 'en'
	const maximum = Math.max(0, ...props.groups.map((group) => group.chargedCost))
	return (
		<div className='min-w-0 space-y-3'>
			<h3 className='text-sm font-medium'>{t(props.title)}</h3>
			{props.groups.length === 0 && (
				<p className='text-muted-foreground py-6 text-center text-xs'>
					{t('cinatoken.account.activity.noGroups')}
				</p>
			)}
			{props.groups.map((group) => {
				const name =
					group.name || group.id || t('cinatoken.account.activity.unknown')
				const rate = activitySuccessRate(group.successCount, group.requestCount)
				return (
					<button
						key={group.id}
						type='button'
						disabled={
							props.disabled || !group.id || group.id.length > props.maxIdLength
						}
						aria-label={t('cinatoken.account.activity.filterGroup', { name })}
						onClick={() => props.onSelect(group.id)}
						className='hover:bg-muted focus-visible:ring-ring relative block w-full overflow-hidden rounded-lg border p-3 text-left outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-60'
					>
						<span
							aria-hidden='true'
							className='bg-primary/5 absolute inset-y-0 left-0'
							style={{
								width: `${maximum > 0 ? (group.chargedCost / maximum) * 100 : 0}%`,
							}}
						/>
						<span className='relative block'>
							<span className='flex items-start justify-between gap-2'>
								<span className='min-w-0 text-sm font-medium break-all'>
									{name}
								</span>
								<span className='shrink-0 text-xs tabular-nums'>
									{formatActivityMoney(
										group.chargedCost,
										props.currency,
										locale,
										t('cinatoken.account.activity.unknown')
									)}
								</span>
							</span>
							<span className='text-muted-foreground mt-2 block text-xs'>
								{t('cinatoken.account.activity.groupUsage', {
									requests: group.requestCount.toLocaleString(locale),
									tokens: group.totalTokens.toLocaleString(locale),
								})}
							</span>
							<span className='text-muted-foreground mt-1 block text-xs'>
								{rate === null
									? t('cinatoken.account.activity.unknown')
									: t('cinatoken.account.activity.successRate', {
											rate: new Intl.NumberFormat(locale, {
												style: 'percent',
												maximumFractionDigits: 1,
											}).format(rate),
										})}
							</span>
						</span>
					</button>
				)
			})}
		</div>
	)
}

export function ActivityBreakdown(props: {
	data: ActivityData
	filters: ActivityFilterForm
	disabled: boolean
	onApply: (filters: ActivityFilterForm) => void
}) {
	const { t } = useTranslation()
	return (
		<Card>
			<CardContent className='space-y-4 p-4'>
				<div>
					<h2 className='font-medium'>
						{t('cinatoken.account.activity.breakdown')}
					</h2>
					<p className='text-muted-foreground mt-1 text-xs'>
						{t('cinatoken.account.activity.breakdownHint', {
							count: props.data.analytics.limit,
						})}
					</p>
				</div>
				<div className='grid gap-5 xl:grid-cols-3'>
					<BreakdownList
						groups={props.data.analytics.models}
						currency={props.data.billingCurrency}
						title='cinatoken.account.activity.models'
						disabled={props.disabled}
						maxIdLength={256}
						onSelect={(id) => props.onApply({ ...props.filters, model_id: id })}
					/>
					<BreakdownList
						groups={props.data.analytics.apiKeys}
						currency={props.data.billingCurrency}
						title='cinatoken.account.activity.keys'
						disabled={props.disabled}
						maxIdLength={128}
						onSelect={(id) =>
							props.onApply({ ...props.filters, api_key_id: id })
						}
					/>
					<BreakdownList
						groups={props.data.analytics.providers}
						currency={props.data.billingCurrency}
						title='cinatoken.account.activity.providers'
						disabled={props.disabled}
						maxIdLength={200}
						onSelect={(id) =>
							props.onApply({ ...props.filters, provider_name: id })
						}
					/>
				</div>
			</CardContent>
		</Card>
	)
}
