import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import type { ActivityGeneration } from '../../activity-contracts'
import { cinatokenApi, CinaTokenApiError } from '../../api'
import { useCinaTokenSession } from '../../session-context'
import { requiresSessionRevalidation } from '../account-access'
import { formatAccountDate } from '../key-display'
import { formatActivityMoney } from './activity-format'
import {
	activityErrorKey,
	activityQueryKey,
	type ActivityScope,
	type SelectedActivityGeneration,
} from './use-activity-manager'

function DetailSection(props: { title: string; children: ReactNode }) {
	const { t } = useTranslation()
	return (
		<section className='space-y-2'>
			<h3 className='text-primary text-sm font-medium'>{t(props.title)}</h3>
			<dl className='grid gap-x-5 sm:grid-cols-2'>{props.children}</dl>
		</section>
	)
}

function DetailItem(props: { label: string; value: string }) {
	const { t } = useTranslation()
	return (
		<div className='min-w-0 border-b py-3'>
			<dt className='text-muted-foreground text-xs'>{t(props.label)}</dt>
			<dd className='mt-1 text-sm break-all'>{props.value}</dd>
		</div>
	)
}

function GenerationData(props: {
	data: ActivityGeneration
	selected: SelectedActivityGeneration
}) {
	const { t, i18n } = useTranslation()
	const locale = i18n.resolvedLanguage ?? 'en'
	const unknown = t('cinatoken.account.activity.unknown')
	const text = (value: string | null | undefined) => value || unknown
	const number = (value: number | null | undefined) =>
		value == null ? unknown : new Intl.NumberFormat(locale).format(value)
	const bool = (value: boolean | null | undefined) =>
		value == null
			? unknown
			: t(
					value
						? 'cinatoken.account.activity.yes'
						: 'cinatoken.account.activity.no'
				)
	const ms = (value: number | null | undefined) =>
		value == null
			? unknown
			: t('cinatoken.account.activity.milliseconds', { value: number(value) })
	const data = props.data
	return (
		<div className='space-y-6'>
			<DetailSection title='cinatoken.account.activity.overview'>
				<DetailItem
					label='cinatoken.account.activity.fields.created_at'
					value={formatAccountDate(data.created_at, locale)}
				/>
				<DetailItem
					label='cinatoken.account.activity.model'
					value={data.model}
				/>
				<DetailItem
					label='cinatoken.account.activity.provider'
					value={text(data.provider_name)}
				/>
				{(
					[
						'api_type',
						'data_region',
						'service_tier',
						'finish_reason',
						'native_finish_reason',
					] as const
				).map((field) => (
					<DetailItem
						key={field}
						label={'cinatoken.account.activity.fields.' + field}
						value={text(data[field])}
					/>
				))}
			</DetailSection>
			<DetailSection title='cinatoken.account.activity.performance'>
				<DetailItem
					label='cinatoken.account.activity.latency'
					value={ms(data.latency)}
				/>
				<DetailItem
					label='cinatoken.account.activity.fields.generation_time'
					value={ms(data.generation_time)}
				/>
				<DetailItem
					label='cinatoken.account.activity.fields.streamed'
					value={bool(data.streamed)}
				/>
				<DetailItem
					label='cinatoken.account.activity.fields.cancelled'
					value={bool(data.cancelled)}
				/>
			</DetailSection>
			<DetailSection title='cinatoken.account.activity.detailUsage'>
				{(
					[
						'tokens_prompt',
						'tokens_completion',
						'native_tokens_prompt',
						'native_tokens_completion',
						'native_tokens_cached',
						'native_tokens_reasoning',
						'native_tokens_completion_images',
						'num_media_prompt',
						'num_media_completion',
					] as const
				).map((field) => (
					<DetailItem
						key={field}
						label={'cinatoken.account.activity.fields.' + field}
						value={number(data[field])}
					/>
				))}
			</DetailSection>
			<DetailSection title='cinatoken.account.activity.detailCost'>
				<div className='min-w-0 border-b py-3'>
					<dt className='text-muted-foreground text-xs'>
						{t('cinatoken.account.activity.chargedCurrency', {
							currency: props.selected.billingCurrency,
						})}
					</dt>
					<dd className='mt-1 text-sm'>
						{formatActivityMoney(
							props.selected.chargedCost,
							props.selected.billingCurrency,
							locale,
							unknown
						)}
					</dd>
				</div>
				<DetailItem
					label='cinatoken.account.activity.totalUsd'
					value={formatActivityMoney(data.total_cost, 'USD', locale, unknown)}
				/>
				<DetailItem
					label='cinatoken.account.activity.upstreamUsd'
					value={formatActivityMoney(
						data.upstream_inference_cost,
						'USD',
						locale,
						unknown
					)}
				/>
				<DetailItem
					label='cinatoken.account.activity.fields.is_byok'
					value={bool(data.is_byok)}
				/>
			</DetailSection>
			<DetailSection title='cinatoken.account.activity.context'>
				{(
					[
						'origin',
						'http_referer',
						'session_id',
						'upstream_id',
						'user_agent',
					] as const
				).map((field) => (
					<DetailItem
						key={field}
						label={'cinatoken.account.activity.fields.' + field}
						value={text(data[field])}
					/>
				))}
			</DetailSection>
			<section className='space-y-3'>
				<h3 className='text-primary text-sm font-medium'>
					{t('cinatoken.account.activity.attempts')}
				</h3>
				{!data.provider_responses?.length && (
					<p className='text-muted-foreground text-sm'>
						{t('cinatoken.account.activity.noAttempts')}
					</p>
				)}
				{data.provider_responses?.map((attempt, index) => (
					<div key={index} className='rounded-lg border p-3'>
						<h4 className='text-sm font-medium'>
							{attempt.provider_name ||
								t('cinatoken.account.activity.attempt', { number: index + 1 })}
						</h4>
						<dl className='grid gap-x-5 sm:grid-cols-2'>
							<DetailItem
								label='cinatoken.account.activity.status'
								value={number(attempt.status)}
							/>
							{(['id', 'endpoint_id', 'model_permaslug'] as const).map(
								(field) => (
									<DetailItem
										key={field}
										label={'cinatoken.account.activity.fields.' + field}
										value={text(attempt[field])}
									/>
								)
							)}
							<DetailItem
								label='cinatoken.account.activity.latency'
								value={ms(attempt.latency)}
							/>
							<DetailItem
								label='cinatoken.account.activity.fields.service_tier'
								value={text(attempt.routed_service_tier)}
							/>
							<DetailItem
								label='cinatoken.account.activity.fields.is_byok'
								value={bool(attempt.is_byok)}
							/>
						</dl>
					</div>
				))}
			</section>
		</div>
	)
}

export function ActivityGenerationDialog(props: {
	scope: ActivityScope
	selected: SelectedActivityGeneration
	onClose: () => void
}) {
	const { t } = useTranslation()
	const session = useCinaTokenSession()
	const options = {
		expectedUserId: props.scope.userId,
		expectedWorkspaceId: props.scope.workspaceId,
	}
	const query = useQuery({
		queryKey: activityQueryKey(
			props.scope,
			'generation',
			props.selected.id,
			options
		),
		queryFn: ({ signal }) =>
			cinatokenApi.activityGeneration(props.selected.id, {
				...options,
				signal,
			}),
		retry: false,
		staleTime: 0,
		refetchOnWindowFocus: false,
	})
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) props.onClose()
			}}
		>
			<DialogContent
				className='max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl'
				showCloseButton={false}
			>
				<DialogHeader>
					<DialogTitle>{t('cinatoken.account.activity.details')}</DialogTitle>
					<DialogDescription>
						{t('cinatoken.account.activity.privacy')}
					</DialogDescription>
				</DialogHeader>
				<code className='text-muted-foreground text-xs break-all'>
					{props.selected.id}
				</code>
				{(query.isPending || query.isFetching) && (
					<Skeleton
						role='status'
						aria-label={t('cinatoken.account.activity.loading')}
						className='h-60'
					/>
				)}
				{query.isError && (
					<div role='alert' className='space-y-3'>
						<p className='text-destructive text-sm'>
							{t(
								query.error instanceof CinaTokenApiError &&
									query.error.status === 404
									? 'cinatoken.account.activity.detailUnavailable'
									: activityErrorKey(query.error)
							)}
						</p>
						<Button
							variant='outline'
							onClick={() => {
								if (requiresSessionRevalidation(query.error))
									void session.revalidateScope()
								else void query.refetch()
							}}
							disabled={query.isFetching}
						>
							{t('cinatoken.account.retry')}
						</Button>
					</div>
				)}
				{query.isSuccess && !query.isFetching && (
					<GenerationData data={query.data} selected={props.selected} />
				)}
				<div className='flex justify-end border-t pt-4'>
					<Button variant='outline' onClick={props.onClose}>
						{t('cinatoken.account.activity.close')}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	)
}
