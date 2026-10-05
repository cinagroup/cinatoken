import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { ActivityData } from '../../activity-contracts'
import {
	activityFormSchema,
	EMPTY_ACTIVITY_FILTERS,
	type ActivityFilterForm,
} from './activity-filter-schema'

const selectClass = 'bg-background h-10 w-full rounded-lg border px-3 text-sm'
export function ActivityFilters(props: {
	values: ActivityFilterForm
	data?: ActivityData
	disabled: boolean
	onApply: (filters: ActivityFilterForm) => void
}) {
	const { t } = useTranslation()
	const form = useForm<ActivityFilterForm>({
		resolver: zodResolver(activityFormSchema),
		values: props.values,
	})
	const selectedKey = props.values.api_key_id
	const knownKey = props.data?.keys.some((key) => key.id === selectedKey)
	return (
		<form
			className='bg-card space-y-3 rounded-xl border p-4'
			onSubmit={form.handleSubmit(props.onApply)}
		>
			<fieldset
				disabled={props.disabled}
				className='grid gap-3 sm:grid-cols-2 xl:grid-cols-3'
			>
				<div className='space-y-2'>
					<Label htmlFor='activity-range'>
						{t('cinatoken.account.activity.range')}
					</Label>
					<select
						id='activity-range'
						className={selectClass}
						{...form.register('range')}
					>
						{(['7d', '30d', '90d'] as const).map((range) => (
							<option key={range} value={range}>
								{t('cinatoken.account.activity.ranges.' + range)}
							</option>
						))}
					</select>
				</div>
				<div className='space-y-2'>
					<Label htmlFor='activity-status'>
						{t('cinatoken.account.activity.status')}
					</Label>
					<select
						id='activity-status'
						className={selectClass}
						{...form.register('status')}
					>
						<option value=''>
							{t('cinatoken.account.activity.allStatuses')}
						</option>
						{(['success', 'error', 'incomplete', 'cancelled'] as const).map(
							(status) => (
								<option key={status} value={status}>
									{t('cinatoken.account.activity.statuses.' + status)}
								</option>
							)
						)}
					</select>
				</div>
				<div className='space-y-2'>
					<Label htmlFor='activity-key'>
						{t('cinatoken.account.activity.apiKey')}
					</Label>
					<select
						id='activity-key'
						className={selectClass}
						{...form.register('api_key_id')}
					>
						<option value=''>{t('cinatoken.account.activity.allKeys')}</option>
						{selectedKey && !knownKey && (
							<option value={selectedKey}>{selectedKey}</option>
						)}
						{props.data?.keys.map((key) => (
							<option key={key.id} value={key.id}>
								{key.name || key.id}
							</option>
						))}
					</select>
				</div>
				<div className='space-y-2'>
					<Label htmlFor='activity-provider'>
						{t('cinatoken.account.activity.provider')}
					</Label>
					<Input
						id='activity-provider'
						list='activity-providers'
						placeholder={t('cinatoken.account.activity.providerPlaceholder')}
						maxLength={200}
						aria-invalid={Boolean(form.formState.errors.provider_name)}
						{...form.register('provider_name')}
					/>
					<datalist id='activity-providers'>
						{props.data?.analytics.providers.map((provider) => (
							<option key={provider.id} value={provider.id}>
								{provider.name || provider.id}
							</option>
						))}
					</datalist>
				</div>
				<div className='space-y-2'>
					<Label htmlFor='activity-model'>
						{t('cinatoken.account.activity.model')}
					</Label>
					<Input
						id='activity-model'
						list='activity-models'
						placeholder={t('cinatoken.account.activity.modelPlaceholder')}
						maxLength={256}
						aria-invalid={Boolean(form.formState.errors.model_id)}
						{...form.register('model_id')}
					/>
					<datalist id='activity-models'>
						{props.data?.analytics.models.map((model) => (
							<option key={model.id} value={model.id}>
								{model.name || model.id}
							</option>
						))}
					</datalist>
				</div>
				<div className='flex flex-wrap items-end gap-2'>
					<Button type='submit'>{t('cinatoken.account.activity.apply')}</Button>
					<Button
						type='button'
						variant='outline'
						onClick={() => {
							form.reset(EMPTY_ACTIVITY_FILTERS)
							props.onApply(EMPTY_ACTIVITY_FILTERS)
						}}
					>
						{t('cinatoken.account.activity.reset')}
					</Button>
				</div>
			</fieldset>
			{Object.keys(form.formState.errors).length > 0 && (
				<p role='alert' className='text-destructive text-xs'>
					{t('cinatoken.account.activity.filterInvalid')}
				</p>
			)}
		</form>
	)
}
