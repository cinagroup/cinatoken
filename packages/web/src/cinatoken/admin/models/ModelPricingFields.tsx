import { useWatch, type UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import { Label } from '../../../components/ui/label'
import { Textarea } from '../../../components/ui/textarea'
import {
	emptyTier,
	TIER_PRICE_FIELDS,
	type ModelFormValues,
	type PricingMode,
} from './model-form'

const prefix = 'cinatoken.adminModels.'
function ImageMaps(props: {
	form: UseFormReturn<ModelFormValues>
	side: 'image' | 'reference'
}) {
	const { t } = useTranslation()
	const draft = useWatch({
		control: props.form.control,
		name: `pricing.${props.side}`,
	})
	return (
		<div className='space-y-3 rounded-lg border p-4'>
			<h3 className='font-medium'>
				{t(
					prefix + (props.side === 'image' ? 'imageOutput' : 'imageReference')
				)}
			</h3>
			<Label htmlFor={'model-' + props.side + '-default'}>
				{t(prefix + 'defaultPrice')}
			</Label>
			<Input
				id={'model-' + props.side + '-default'}
				{...props.form.register(`pricing.${props.side}.default`)}
				inputMode='decimal'
			/>
			{(['by_quality', 'by_size', 'by_quality_size'] as const).map((field) => (
				<div key={field} className='space-y-2'>
					<p className='text-sm font-medium'>{t(prefix + field)}</p>
					{draft[field].map((_, index) => (
						<div
							key={index}
							className='grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2'
						>
							<Input
								{...props.form.register(
									`pricing.${props.side}.${field}.${index}.key`
								)}
								aria-label={t(prefix + 'mapKey')}
							/>
							<Input
								{...props.form.register(
									`pricing.${props.side}.${field}.${index}.price`
								)}
								inputMode='decimal'
								aria-label={t(prefix + 'price')}
							/>
							<Button
								type='button'
								variant='outline'
								onClick={() =>
									props.form.setValue(
										`pricing.${props.side}.${field}`,
										draft[field].filter((_, i) => i !== index)
									)
								}
							>
								{t(prefix + 'remove')}
							</Button>
						</div>
					))}
					<Button
						type='button'
						variant='outline'
						onClick={() =>
							props.form.setValue(`pricing.${props.side}.${field}`, [
								...draft[field],
								{ key: '', price: '' },
							])
						}
					>
						{t(prefix + 'addMap')}
					</Button>
				</div>
			))}
		</div>
	)
}
export function ModelPricingFields(props: {
	form: UseFormReturn<ModelFormValues>
	editing: boolean
	billingCurrency: string | null
}) {
	const { t } = useTranslation()
	const pricing = useWatch({ control: props.form.control, name: 'pricing' })
	const action = useWatch({
		control: props.form.control,
		name: 'pricingAction',
	})
	const token = ['token', 'image_token', 'audio_token'].includes(pricing.mode)
	function mode(next: PricingMode): void {
		props.form.setValue('pricing.mode', next)
		if (next === 'per_character') {
			props.form.setValue('output_modalities', ['speech'])
			props.form.setValue('input_modalities', ['text'])
		} else if (['per_second', 'audio_token'].includes(next)) {
			props.form.setValue('output_modalities', ['transcription'])
			props.form.setValue('input_modalities', ['audio'])
		}
	}
	return (
		<section className='space-y-4 rounded-xl border p-4'>
			<h2 className='font-semibold'>{t(prefix + 'pricing')}</h2>
			<p className='text-muted-foreground text-sm'>
				{props.billingCurrency
					? t(prefix + 'currencyCurrent', { currency: props.billingCurrency })
					: t(prefix + 'currencyUnknown')}
			</p>
			{props.editing && (
				<div className='space-y-2'>
					<Label htmlFor='model-price-action'>
						{t(prefix + 'pricingAction')}
					</Label>
					<select
						id='model-price-action'
						{...props.form.register('pricingAction')}
						className='bg-background h-10 w-full rounded-md border px-3'
					>
						{['keep', 'replace', 'clear'].map((value) => (
							<option key={value} value={value}>
								{t(prefix + value)}
							</option>
						))}
					</select>
				</div>
			)}
			{action === 'clear' && (
				<p className='text-destructive text-sm'>
					{t(prefix + 'clearPriceWarning')}
				</p>
			)}
			{action === 'keep' && (
				<p className='text-muted-foreground text-sm'>
					{t(prefix + 'keepPriceHint')}
				</p>
			)}
			{action === 'replace' && (
				<>
					<Label htmlFor='model-pricing-mode'>
						{t(prefix + 'billingMode')}
					</Label>
					<select
						id='model-pricing-mode'
						value={pricing.mode}
						onChange={(event) => mode(event.target.value as PricingMode)}
						className='bg-background h-10 w-full rounded-md border px-3'
					>
						{[
							'token',
							'image_token',
							'per_image',
							'audio_token',
							'per_second',
							'per_character',
						].map((value) => (
							<option key={value} value={value}>
								{t(prefix + value)}
							</option>
						))}
					</select>
					<label className='flex items-center gap-2'>
						<input
							type='checkbox'
							{...props.form.register('pricing.advanced')}
						/>
						{t(prefix + 'advancedProfile')}
					</label>
					{pricing.advanced ? (
						<div className='space-y-2'>
							<Label htmlFor='model-advanced-pricing'>
								{t(prefix + 'pricingJson')}
							</Label>
							<Textarea
								id='model-advanced-pricing'
								{...props.form.register('pricing.raw')}
								rows={12}
								spellCheck={false}
								className='font-mono'
							/>
							<p className='text-muted-foreground text-xs'>
								{t(prefix + 'advancedHint')}
							</p>
						</div>
					) : (
						<>
							{token && (
								<div className='space-y-4'>
									<p className='text-muted-foreground text-sm'>
										{t(prefix + 'tokenUnit')}
									</p>
									{pricing.tiers.map((_, index) => (
										<div
											key={index}
											className='space-y-3 rounded-lg border p-3'
										>
											<div className='flex items-center justify-between gap-3'>
												<h3 className='font-medium'>
													{t(prefix + 'tier', { number: index + 1 })}
												</h3>
												<Button
													type='button'
													variant='outline'
													disabled={pricing.tiers.length === 1}
													onClick={() =>
														props.form.setValue(
															'pricing.tiers',
															pricing.tiers.filter((_, i) => i !== index)
														)
													}
												>
													{t(prefix + 'remove')}
												</Button>
											</div>
											<div className='grid gap-3 sm:grid-cols-2'>
												<div className='space-y-2'>
													<Label htmlFor={'model-tier-bound-' + index}>
														{t(prefix + 'upto')}
													</Label>
													<Input
														id={'model-tier-bound-' + index}
														{...props.form.register(
															`pricing.tiers.${index}.upto`
														)}
														inputMode='numeric'
														placeholder={
															index === pricing.tiers.length - 1
																? '∞'
																: undefined
														}
													/>
												</div>
												<div className='space-y-2'>
													<Label htmlFor={'model-tier-label-' + index}>
														{t(prefix + 'tierLabel')}
													</Label>
													<Input
														id={'model-tier-label-' + index}
														{...props.form.register(
															`pricing.tiers.${index}.label`
														)}
													/>
												</div>
												{TIER_PRICE_FIELDS.map((field) => (
													<div key={field} className='space-y-2'>
														<Label
															htmlFor={'model-tier-' + index + '-' + field}
														>
															{t(prefix + field)}
														</Label>
														<Input
															id={'model-tier-' + index + '-' + field}
															{...props.form.register(
																`pricing.tiers.${index}.${field}`
															)}
															inputMode='decimal'
														/>
													</div>
												))}
											</div>
										</div>
									))}
									<Button
										type='button'
										variant='outline'
										onClick={() =>
											props.form.setValue('pricing.tiers', [
												...pricing.tiers,
												emptyTier(),
											])
										}
									>
										{t(prefix + 'addTier')}
									</Button>
								</div>
							)}
							{pricing.mode === 'per_image' && (
								<>
									<p className='text-muted-foreground text-sm'>
										{t(prefix + 'imageUnit')}
									</p>
									<div className='grid gap-4 lg:grid-cols-2'>
										<ImageMaps form={props.form} side='image' />
										<ImageMaps form={props.form} side='reference' />
									</div>
									<Label htmlFor='model-image-policy'>
										{t(prefix + 'uncertainPolicy')}
									</Label>
									<select
										id='model-image-policy'
										{...props.form.register('pricing.policy')}
										className='bg-background h-10 w-full rounded-md border px-3'
									>
										<option value='requested'>{t(prefix + 'requested')}</option>
										<option value='zero'>{t(prefix + 'zero')}</option>
									</select>
								</>
							)}
							{['per_second', 'per_character'].includes(pricing.mode) && (
								<div className='grid gap-3 sm:grid-cols-2'>
									<div className='space-y-2'>
										<Label htmlFor='model-audio-price'>
											{t(
												prefix +
													(pricing.mode === 'per_second'
														? 'secondPrice'
														: 'characterPrice')
											)}
										</Label>
										<Input
											id='model-audio-price'
											{...props.form.register('pricing.audioPrice')}
											inputMode='decimal'
										/>
									</div>
									<div className='space-y-2'>
										<Label htmlFor='model-audio-minimum'>
											{t(
												prefix +
													(pricing.mode === 'per_second'
														? 'minimumSeconds'
														: 'minimumCharacters')
											)}
										</Label>
										<Input
											id='model-audio-minimum'
											{...props.form.register('pricing.minimum')}
											inputMode='decimal'
										/>
									</div>
								</div>
							)}
						</>
					)}
				</>
			)}
		</section>
	)
}
