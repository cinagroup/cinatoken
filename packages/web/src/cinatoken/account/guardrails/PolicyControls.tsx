import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
	GUARDRAIL_BUILTINS,
	GUARDRAIL_GROUPS,
	type GuardrailConfig,
} from '../../guardrail-contracts'

type Props = {
	value: GuardrailConfig
	onChange(value: GuardrailConfig): void
	accountDefault: boolean
	currency: string
	disabled: boolean
}
type Selector =
	| 'allowed_models'
	| 'allowed_providers'
	| 'ignored_models'
	| 'ignored_providers'
type Filter = NonNullable<GuardrailConfig['input_filters']>[number]
const selectors: readonly Selector[] = [
	'allowed_models',
	'ignored_models',
	'allowed_providers',
	'ignored_providers',
]
function Filters(props: {
	value: Filter[]
	onChange(value: Filter[]): void
	type: 'inputFilters' | 'outputFilters'
	disabled: boolean
}) {
	const { t } = useTranslation()
	const prefix = useId()
	const text = (key: string) => t(`cinatoken.account.guardrails.${key}`)
	function update(index: number, patch: Partial<Filter>) {
		props.onChange(
			props.value.map((value, at) =>
				at === index ? { ...value, ...patch } : value
			)
		)
	}
	return (
		<fieldset
			disabled={props.disabled}
			className='space-y-3 rounded-lg border p-3'
		>
			<legend className='px-1 font-medium'>{text(props.type)}</legend>
			<p className='text-muted-foreground text-xs leading-5'>
				{text('regexHint')}
			</p>
			{props.value.map((filter, index) => (
				<div key={index} className='bg-muted/40 space-y-2 rounded-lg p-3'>
					<label className='block space-y-1' htmlFor={`${prefix}-id-${index}`}>
						<span>{text('filterId')}</span>
						<Input
							id={`${prefix}-id-${index}`}
							value={filter.id}
							maxLength={64}
							onChange={(e) => update(index, { id: e.target.value })}
						/>
					</label>
					<label
						className='block space-y-1'
						htmlFor={`${prefix}-pattern-${index}`}
					>
						<span>{text('pattern')}</span>
						<Input
							id={`${prefix}-pattern-${index}`}
							value={filter.pattern}
							maxLength={512}
							onChange={(e) => update(index, { pattern: e.target.value })}
						/>
					</label>
					<label
						className='block space-y-1'
						htmlFor={`${prefix}-label-${index}`}
					>
						<span>{text('label')}</span>
						<Input
							id={`${prefix}-label-${index}`}
							value={filter.label ?? ''}
							maxLength={200}
							onChange={(e) =>
								update(index, { label: e.target.value || undefined })
							}
						/>
					</label>
					<label
						className='flex flex-wrap items-center gap-2'
						htmlFor={`${prefix}-action-${index}`}
					>
						<span>{text('action')}</span>
						<select
							className='bg-background h-9 rounded-md border px-2'
							id={`${prefix}-action-${index}`}
							value={filter.action}
							onChange={(e) =>
								update(index, {
									action: e.target.value === 'block' ? 'block' : 'redact',
								})
							}
						>
							<option value='block'>{text('block')}</option>
							<option value='redact'>{text('redact')}</option>
						</select>
					</label>
					<Button
						type='button'
						variant='outline'
						size='sm'
						onClick={() =>
							props.onChange(props.value.filter((_, at) => at !== index))
						}
					>
						{text('removeFilter')}
					</Button>
				</div>
			))}
			<Button
				type='button'
				variant='outline'
				size='sm'
				disabled={props.value.length >= 32}
				onClick={() =>
					props.onChange([
						...props.value,
						{
							id: `filter-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`,
							pattern: '',
							action: 'block',
						},
					])
				}
			>
				{text('addFilter')}
			</Button>
		</fieldset>
	)
}
export function PolicyControls(props: Props) {
	const { t } = useTranslation()
	const prefix = useId()
	const text = (key: string) => t(`cinatoken.account.guardrails.${key}`)
	function patch(value: Partial<GuardrailConfig>) {
		props.onChange({ ...props.value, ...value })
	}
	return (
		<fieldset disabled={props.disabled} className='space-y-5'>
			<legend className='mb-3 font-medium'>{text('policyFields')}</legend>
			<p className='text-muted-foreground text-sm leading-6'>
				{text('selectorsHint')}
			</p>
			<div className='grid gap-4 sm:grid-cols-2'>
				{selectors.map((key) => (
					<div key={key} className='space-y-2 rounded-lg border p-3'>
						<label
							className='flex items-center gap-2'
							htmlFor={`${prefix}-${key}-enabled`}
						>
							<input
								id={`${prefix}-${key}-enabled`}
								type='checkbox'
								checked={props.value[key] !== undefined}
								onChange={(e) =>
									patch({ [key]: e.target.checked ? [] : undefined })
								}
							/>
							<span>{text(key)}</span>
						</label>
						{props.value[key] !== undefined ? (
							<Textarea
								aria-label={text(key)}
								defaultValue={props.value[key]?.join('\n')}
								rows={3}
								onChange={(e) =>
									patch({
										[key]: e.target.value
											.split('\n')
											.filter((line) => line.trim()),
									})
								}
							/>
						) : (
							<p className='text-muted-foreground text-xs'>
								{text('unrestricted')}
							</p>
						)}
					</div>
				))}
			</div>
			<fieldset className='space-y-3 rounded-lg border p-3'>
				<legend className='px-1 font-medium'>{text('privacy')}</legend>
				<label className='flex items-center gap-2'>
					<input
						type='checkbox'
						checked={props.value.data_collection === 'deny'}
						onChange={(e) =>
							patch({ data_collection: e.target.checked ? 'deny' : undefined })
						}
					/>
					{text('denyCollection')}
				</label>
				<label className='flex items-center gap-2'>
					<input
						type='checkbox'
						checked={props.value.require_zdr ?? false}
						onChange={(e) => patch({ require_zdr: e.target.checked })}
					/>
					{text('requireZdr')}
				</label>
				<p className='text-muted-foreground text-xs'>{text('zdr')}</p>
				<div className='flex flex-wrap gap-x-5 gap-y-2'>
					{GUARDRAIL_GROUPS.map((group) => (
						<label key={group} className='flex items-center gap-2'>
							<input
								type='checkbox'
								checked={props.value.zdr?.[group] ?? false}
								onChange={(e) =>
									patch({
										zdr: { ...props.value.zdr, [group]: e.target.checked },
									})
								}
							/>
							{group}
						</label>
					))}
				</div>
			</fieldset>
			{props.accountDefault ? (
				<p className='text-muted-foreground text-sm'>{text('defaultLimit')}</p>
			) : (
				<>
					<fieldset className='space-y-3 rounded-lg border p-3'>
						<legend className='px-1 font-medium'>{text('budget')}</legend>
						<p className='text-muted-foreground text-xs leading-5'>
							{t('cinatoken.account.guardrails.budgetHint', {
								currency: props.currency,
							})}
						</p>
						<label className='flex items-center gap-2'>
							<input
								type='checkbox'
								checked={props.value.budget !== undefined}
								onChange={(e) =>
									patch({
										budget: e.target.checked
											? { limit: 1, period: 'daily' }
											: undefined,
									})
								}
							/>
							{text('budgetEnabled')}
						</label>
						{props.value.budget ? (
							<div className='grid gap-3 sm:grid-cols-2'>
								<label className='space-y-1' htmlFor={`${prefix}-limit`}>
									<span>
										{text('limit')} ({props.currency})
									</span>
									<Input
										id={`${prefix}-limit`}
										type='number'
										step='0.000001'
										min='0.000001'
										max='1000000000'
										value={props.value.budget.limit}
										onChange={(e) =>
											patch({
												budget: {
													limit: Number(e.target.value),
													period: props.value.budget?.period ?? 'daily',
												},
											})
										}
									/>
								</label>
								<label className='space-y-1' htmlFor={`${prefix}-period`}>
									<span>{text('budget')}</span>
									<select
										id={`${prefix}-period`}
										className='bg-background h-9 w-full rounded-md border px-2'
										value={props.value.budget.period}
										onChange={(e) => {
											const period = e.target.value
											if (
												period === 'daily' ||
												period === 'weekly' ||
												period === 'monthly'
											)
												patch({
													budget: {
														limit: props.value.budget?.limit ?? 1,
														period,
													},
												})
										}}
									>
										{['daily', 'weekly', 'monthly'].map((period) => (
											<option key={period} value={period}>
												{text(period)}
											</option>
										))}
									</select>
								</label>
							</div>
						) : null}
					</fieldset>
					<fieldset className='space-y-3 rounded-lg border p-3'>
						<legend className='px-1 font-medium'>{text('builtins')}</legend>
						{GUARDRAIL_BUILTINS.map((slug) => {
							const current = props.value.content_filter_builtins?.find(
								(row) => row.slug === slug
							)
							return (
								<div className='flex flex-wrap items-center gap-3' key={slug}>
									<label className='flex flex-1 items-center gap-2'>
										<input
											type='checkbox'
											checked={Boolean(current)}
											onChange={(e) =>
												patch({
													content_filter_builtins: e.target.checked
														? [
																...(props.value.content_filter_builtins ?? []),
																{ slug, action: 'block' },
															]
														: props.value.content_filter_builtins?.filter(
																(row) => row.slug !== slug
															),
												})
											}
										/>
										{slug}
									</label>
									{current ? (
										<select
											aria-label={`${slug} ${text('action')}`}
											className='bg-background h-9 rounded-md border px-2'
											value={current.action}
											onChange={(e) => {
												const action = e.target.value
												if (
													action === 'block' ||
													action === 'redact' ||
													action === 'flag'
												)
													patch({
														content_filter_builtins:
															props.value.content_filter_builtins?.map((row) =>
																row.slug === slug ? { ...row, action } : row
															),
													})
											}}
										>
											<option value='block'>{text('block')}</option>
											<option value='redact'>{text('redact')}</option>
											{slug === 'regex-prompt-injection' ? (
												<option value='flag'>{text('flag')}</option>
											) : null}
										</select>
									) : null}
								</div>
							)
						})}
					</fieldset>
					<Filters
						type='inputFilters'
						disabled={props.disabled}
						value={props.value.input_filters ?? []}
						onChange={(input_filters) => patch({ input_filters })}
					/>
					<Filters
						type='outputFilters'
						disabled={props.disabled}
						value={props.value.output_filters ?? []}
						onChange={(output_filters) => patch({ output_filters })}
					/>
					<fieldset className='space-y-3 rounded-lg border p-3'>
						<legend className='px-1 font-medium'>{text('openrouter')}</legend>
						<p className='text-muted-foreground text-xs leading-5'>
							{text('openrouterHint')}
						</p>
						{(
							[
								'enable_free_model_publication',
								'enable_free_model_training',
								'enable_paid_model_training',
							] as const
						).map((key) => (
							<label key={key} className='flex items-center gap-2'>
								<input
									type='checkbox'
									checked={props.value.openrouter?.[key] ?? false}
									onChange={(e) =>
										patch({
											openrouter: {
												...props.value.openrouter,
												[key]: e.target.checked ? true : undefined,
											},
										})
									}
								/>
								{text(key)}
							</label>
						))}
					</fieldset>
				</>
			)}
		</fieldset>
	)
}
