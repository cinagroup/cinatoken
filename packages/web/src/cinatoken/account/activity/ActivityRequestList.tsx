import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
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
import type { ActivityData, ActivityLog } from '../../activity-contracts'
import { formatAccountDate } from '../key-display'
import {
	canOpenActivityGeneration,
	formatActivityMoney,
} from './activity-format'

function RequestStatus(props: { status: ActivityLog['status'] }) {
	const { t } = useTranslation()
	return (
		<Badge variant={props.status === 'error' ? 'destructive' : 'outline'}>
			{t('cinatoken.account.activity.statuses.' + props.status)}
		</Badge>
	)
}

function RequestId(props: {
	row: ActivityLog
	disabled: boolean
	onDetails: (row: ActivityLog) => void
}) {
	const { t } = useTranslation()
	if (!canOpenActivityGeneration(props.row))
		return (
			<code title={props.row.id} className='text-xs break-all'>
				{props.row.id}
			</code>
		)
	return (
		<button
			type='button'
			title={props.row.id}
			aria-label={t('cinatoken.account.activity.viewDetails', {
				id: props.row.id,
			})}
			disabled={props.disabled}
			onClick={() => props.onDetails(props.row)}
			className='text-primary focus-visible:ring-ring rounded font-mono text-xs break-all underline underline-offset-4 outline-none focus-visible:ring-2 disabled:opacity-50'
		>
			{props.row.id}
		</button>
	)
}

function RequestUsage(props: { row: ActivityLog }) {
	const { t, i18n } = useTranslation()
	const locale = i18n.resolvedLanguage ?? 'en'
	return (
		<div className='space-y-1 text-xs tabular-nums'>
			<p className='text-foreground text-sm'>
				{props.row.totalTokens.toLocaleString(locale)}
			</p>
			<p>
				{t('cinatoken.account.activity.inputOutput', {
					input: props.row.inputTokens.toLocaleString(locale),
					output: props.row.outputTokens.toLocaleString(locale),
				})}
			</p>
			{(props.row.inputImageCount > 0 || props.row.outputImageCount > 0) && (
				<p>
					{t('cinatoken.account.activity.images', {
						input: props.row.inputImageCount.toLocaleString(locale),
						output: props.row.outputImageCount.toLocaleString(locale),
					})}
				</p>
			)}
			{props.row.audioDurationSeconds !== null && (
				<p>
					{t('cinatoken.account.activity.seconds', {
						value: props.row.audioDurationSeconds.toLocaleString(locale),
					})}
				</p>
			)}
			{props.row.audioCharacters !== null && (
				<p>
					{t('cinatoken.account.activity.audioCharacters', {
						count: props.row.audioCharacters.toLocaleString(locale),
					})}
				</p>
			)}
		</div>
	)
}

export function ActivityRequestList(props: {
	data: ActivityData
	disabled: boolean
	onDetails: (row: ActivityLog) => void
	onPage: (page: number) => void
}) {
	const { t, i18n } = useTranslation()
	const locale = i18n.resolvedLanguage ?? 'en'
	const unknown = t('cinatoken.account.activity.unknown')
	const pagination = props.data.pagination
	const latency = (value: number | null) =>
		value === null
			? unknown
			: t('cinatoken.account.activity.milliseconds', {
					value: Math.round(value).toLocaleString(locale),
				})
	return (
		<Card>
			<CardContent className='space-y-4 p-4'>
				<h2 className='font-medium'>
					{t('cinatoken.account.activity.recent')}
				</h2>
				{props.data.logs.length === 0 && (
					<p className='text-muted-foreground py-12 text-center text-sm'>
						{t('cinatoken.account.activity.noActivity')}
					</p>
				)}
				{props.data.logs.length > 0 && (
					<>
						<div className='space-y-3 md:hidden'>
							{props.data.logs.map((row) => (
								<article
									key={row.id}
									className='space-y-3 rounded-lg border p-3'
								>
									<div className='flex items-start justify-between gap-3'>
										<div className='min-w-0'>
											<RequestId
												row={row}
												disabled={props.disabled}
												onDetails={props.onDetails}
											/>
											<p className='text-muted-foreground mt-1 text-xs'>
												{formatAccountDate(row.createdAt, locale)}
											</p>
										</div>
										<RequestStatus status={row.status} />
									</div>
									<dl className='grid gap-3 border-y py-3 sm:grid-cols-2'>
										{[
											{
												label: 'model',
												value: row.modelName || row.modelId || unknown,
											},
											{ label: 'provider', value: row.providerName || unknown },
											{
												label: 'apiKey',
												value: row.apiKeyName || row.apiKeyId || unknown,
											},
											{ label: 'latency', value: latency(row.latencyMs) },
										].map((item) => (
											<div key={item.label}>
												<dt className='text-muted-foreground text-xs'>
													{t('cinatoken.account.activity.' + item.label)}
												</dt>
												<dd className='mt-1 text-sm break-all'>{item.value}</dd>
											</div>
										))}
									</dl>
									<div className='flex items-start justify-between gap-3'>
										<div className='text-muted-foreground'>
											<RequestUsage row={row} />
										</div>
										<div className='text-right'>
											<p className='text-xs font-medium tabular-nums'>
												{formatActivityMoney(
													row.chargedCost,
													props.data.billingCurrency,
													locale,
													unknown
												)}
											</p>
											<p className='text-muted-foreground mt-1 text-xs'>
												{row.billingKind}
											</p>
										</div>
									</div>
									{(row.protocol || row.operation) && (
										<p className='text-muted-foreground text-xs break-all'>
											{[row.protocol, row.operation]
												.filter(Boolean)
												.join(' · ')}
										</p>
									)}
								</article>
							))}
						</div>
						<div className='hidden max-w-full md:block'>
							<Table className='min-w-[980px]'>
								<TableHeader>
									<TableRow>
										{[
											'time',
											'request',
											'model',
											'provider',
											'apiKey',
											'status',
											'usage',
											'cost',
											'latency',
										].map((key) => (
											<TableHead key={key}>
												{t('cinatoken.account.activity.' + key)}
											</TableHead>
										))}
									</TableRow>
								</TableHeader>
								<TableBody>
									{props.data.logs.map((row) => (
										<TableRow key={row.id}>
											<TableCell className='text-xs whitespace-nowrap'>
												{formatAccountDate(row.createdAt, locale)}
											</TableCell>
											<TableCell className='max-w-44'>
												<RequestId
													row={row}
													disabled={props.disabled}
													onDetails={props.onDetails}
												/>
												<p className='text-muted-foreground mt-1 text-xs'>
													{row.protocol}
												</p>
											</TableCell>
											<TableCell className='max-w-48 break-all'>
												<p className='text-sm'>
													{row.modelName || row.modelId || unknown}
												</p>
												<p className='text-muted-foreground mt-1 text-xs'>
													{row.operation}
												</p>
											</TableCell>
											<TableCell className='max-w-36 text-xs break-all'>
												{row.providerName || unknown}
											</TableCell>
											<TableCell className='max-w-40 text-xs break-all'>
												{row.apiKeyName || row.apiKeyId || unknown}
											</TableCell>
											<TableCell>
												<RequestStatus status={row.status} />
											</TableCell>
											<TableCell className='text-muted-foreground'>
												<RequestUsage row={row} />
											</TableCell>
											<TableCell className='text-xs whitespace-nowrap tabular-nums'>
												{formatActivityMoney(
													row.chargedCost,
													props.data.billingCurrency,
													locale,
													unknown
												)}
												<p className='text-muted-foreground mt-1'>
													{row.billingKind}
												</p>
											</TableCell>
											<TableCell className='text-xs whitespace-nowrap tabular-nums'>
												{latency(row.latencyMs)}
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</div>
					</>
				)}
				<div className='flex flex-wrap items-center justify-between gap-3 border-t pt-4'>
					<p className='text-muted-foreground text-xs'>
						{t('cinatoken.account.activity.pagination', {
							page: pagination.page,
							pages: pagination.totalPages,
							total: pagination.total.toLocaleString(locale),
						})}
					</p>
					<div className='flex gap-2'>
						<Button
							variant='outline'
							size='sm'
							disabled={props.disabled || pagination.page <= 1}
							onClick={() => props.onPage(pagination.page - 1)}
						>
							{t('cinatoken.account.activity.previous')}
						</Button>
						<Button
							variant='outline'
							size='sm'
							disabled={
								props.disabled ||
								pagination.page >= pagination.totalPages ||
								pagination.page >= 100_000
							}
							onClick={() => props.onPage(pagination.page + 1)}
						>
							{t('cinatoken.account.activity.next')}
						</Button>
					</div>
				</div>
			</CardContent>
		</Card>
	)
}
