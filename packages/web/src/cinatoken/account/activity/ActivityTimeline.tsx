import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
	Area,
	AreaChart,
	CartesianGrid,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from 'recharts'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@/components/ui/table'
import type { ActivityTimelinePoint } from '../../activity-contracts'
import { formatAccountDate } from '../key-display'
import {
	activityMetricValue,
	formatActivityMoney,
	type ActivityMetric,
} from './activity-format'

export function ActivityTimeline(props: {
	points: ActivityTimelinePoint[]
	granularity: 'hour' | 'day'
	currency: string
}) {
	const { t, i18n } = useTranslation()
	const locale = i18n.resolvedLanguage ?? 'en'
	const [metric, setMetric] = useState<ActivityMetric>('requests')
	const metrics = [
		{ id: 'requests', label: 'requests' },
		{ id: 'tokens', label: 'tokens' },
		{ id: 'cost', label: 'cost' },
		{ id: 'latency', label: 'latency' },
	] as const
	const data = useMemo(
		() =>
			props.points.map((point) => ({
				bucket: point.bucket,
				label: formatAccountDate(point.bucket, locale),
				value: activityMetricValue(point, metric),
			})),
		[props.points, locale, metric]
	)
	const hasValues = data.some((point) => point.value !== null)
	const formatValue = (value: number | null) => {
		if (value === null) return t('cinatoken.account.activity.unknown')
		if (metric === 'cost')
			return formatActivityMoney(
				value,
				props.currency,
				locale,
				t('cinatoken.account.activity.unknown')
			)
		if (metric === 'latency')
			return t('cinatoken.account.activity.milliseconds', {
				value: new Intl.NumberFormat(locale, {
					maximumFractionDigits: 1,
				}).format(value),
			})
		return new Intl.NumberFormat(locale).format(value)
	}
	return (
		<Card>
			<CardContent className='space-y-4 p-4'>
				<div className='flex flex-wrap items-start justify-between gap-3'>
					<div>
						<h2 className='font-medium'>
							{t('cinatoken.account.activity.trend')}
						</h2>
						<p className='text-muted-foreground mt-1 text-xs'>
							{t('cinatoken.account.activity.trendHint', {
								granularity: t(
									props.granularity === 'hour'
										? 'cinatoken.account.activity.hourly'
										: 'cinatoken.account.activity.daily'
								),
							})}
						</p>
					</div>
					<div
						role='group'
						aria-label={t('cinatoken.account.activity.metric')}
						className='flex flex-wrap gap-1'
					>
						{metrics.map((item) => (
							<Button
								key={item.id}
								size='sm'
								variant={metric === item.id ? 'secondary' : 'ghost'}
								aria-pressed={metric === item.id}
								onClick={() => setMetric(item.id)}
							>
								{t('cinatoken.account.activity.' + item.label)}
							</Button>
						))}
					</div>
				</div>
				{data.length === 0 || !hasValues ? (
					<p className='text-muted-foreground py-16 text-center text-sm'>
						{t('cinatoken.account.activity.noTimeline')}
					</p>
				) : (
					<div
						className='h-64 min-w-0'
						role='img'
						aria-label={t('cinatoken.account.activity.chartLabel', {
							metric: t('cinatoken.account.activity.' + metric),
						})}
					>
						<ResponsiveContainer width='100%' height={256} minWidth={0}>
							<AreaChart
								data={data}
								accessibilityLayer
								margin={{ top: 8, right: 8, left: 4, bottom: 0 }}
							>
								<CartesianGrid
									vertical={false}
									stroke='var(--border)'
									strokeDasharray='3 3'
								/>
								<XAxis
									dataKey='label'
									axisLine={false}
									tickLine={false}
									minTickGap={30}
									tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
								/>
								<YAxis
									axisLine={false}
									tickLine={false}
									width={74}
									tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
									tickFormatter={(value: number) =>
										new Intl.NumberFormat(locale, {
											notation: 'compact',
											maximumFractionDigits: 1,
										}).format(value)
									}
								/>
								<Tooltip
									content={({ active, payload, label }) =>
										active && typeof payload?.[0]?.value === 'number' ? (
											<div className='bg-popover rounded-lg border px-3 py-2 text-xs shadow-md'>
												<p className='text-muted-foreground'>{String(label)}</p>
												<p className='mt-1 font-medium'>
													{formatValue(payload[0].value)}
												</p>
											</div>
										) : null
									}
								/>
								<Area
									type='monotone'
									dataKey='value'
									stroke='var(--primary)'
									fill='var(--primary)'
									fillOpacity={0.12}
									strokeWidth={2}
									connectNulls={false}
									isAnimationActive={false}
								/>
							</AreaChart>
						</ResponsiveContainer>
					</div>
				)}
				{data.length > 0 && (
					<details className='rounded-lg border p-3'>
						<summary className='cursor-pointer text-xs font-medium'>
							{t('cinatoken.account.activity.chartValues')}
						</summary>
						<div className='mt-3 max-h-64 overflow-auto'>
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>
											{t('cinatoken.account.activity.time')}
										</TableHead>
										<TableHead>
											{t('cinatoken.account.activity.' + metric)}
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{data.map((point) => (
										<TableRow key={point.bucket}>
											<TableCell className='text-xs'>{point.label}</TableCell>
											<TableCell className='text-xs tabular-nums'>
												{formatValue(point.value)}
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</div>
					</details>
				)}
			</CardContent>
		</Card>
	)
}
