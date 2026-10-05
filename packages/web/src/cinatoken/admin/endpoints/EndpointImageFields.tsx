/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import { Label } from '../../../components/ui/label'
import type {
	EndpointFormValues,
	ImageParameterDraft,
	ImagePriceDraft,
} from './endpoint-form'

const prefix = 'cinatoken.adminEndpoints.'
const selectClass =
	'bg-background h-10 w-full min-w-0 rounded-md border px-3 text-sm'
const billables = [
	'output_image',
	'input_image',
	'input_font',
	'input_reference',
	'input_text',
] as const
const units = ['request', 'image', 'megapixel', 'token'] as const
const newParameter = (): ImageParameterDraft => ({
	name: '',
	type: 'boolean',
	values: [],
	min: '',
	max: '',
})
const newPrice = (): ImagePriceDraft => ({
	billable: 'output_image',
	unit: 'image',
	cost_usd: '',
	variant: '',
})

export function EndpointImageFields(props: {
	form: UseFormReturn<EndpointFormValues>
}) {
	const { t } = useTranslation()
	const enabled = props.form.watch('image.enabled')
	const parameters = props.form.watch('image.parameters')
	const prices = props.form.watch('image.prices')
	function setParameters(next: ImageParameterDraft[]): void {
		props.form.setValue('image.parameters', next, { shouldDirty: true })
	}
	function setPrices(next: ImagePriceDraft[]): void {
		props.form.setValue('image.prices', next, { shouldDirty: true })
	}
	return (
		<section className='space-y-4'>
			<h3 className='text-base font-semibold'>
				{t(prefix + 'imageCapabilities')}
			</h3>
			<label className='flex items-center gap-2 text-sm'>
				<input type='checkbox' {...props.form.register('image.enabled')} />
				{t(prefix + 'imageEnabled')}
			</label>
			{enabled && (
				<div className='space-y-5'>
					<div className='grid gap-4 sm:grid-cols-2'>
						<div className='space-y-2'>
							<Label htmlFor='endpoint-image-tag'>
								{t(prefix + 'imageProviderTag')}
							</Label>
							<Input
								id='endpoint-image-tag'
								{...props.form.register('image.provider_tag')}
							/>
						</div>
						<div className='space-y-2'>
							<Label htmlFor='endpoint-image-streaming'>
								{t(prefix + 'streaming')}
							</Label>
							<select
								id='endpoint-image-streaming'
								className={selectClass}
								{...props.form.register('image.streaming')}
							>
								<option value='unknown'>{t(prefix + 'unknown')}</option>
								<option value='true'>{t(prefix + 'supported')}</option>
								<option value='false'>{t(prefix + 'unsupported')}</option>
							</select>
						</div>
					</div>
					<div className='space-y-2'>
						<Label htmlFor='endpoint-image-passthrough'>
							{t(prefix + 'imagePassthrough')}
						</Label>
						<Input
							id='endpoint-image-passthrough'
							{...props.form.register('image.passthrough')}
						/>
						<p className='text-muted-foreground text-xs'>
							{t(prefix + 'imagePassthroughHint')}
						</p>
					</div>
					<div className='space-y-3 rounded-xl border p-4'>
						<div className='flex flex-wrap items-center justify-between gap-2'>
							<h4 className='font-medium'>{t(prefix + 'imageParameters')}</h4>
							<Button
								type='button'
								variant='outline'
								size='sm'
								onClick={() => setParameters([...parameters, newParameter()])}
							>
								{t(prefix + 'addParameter')}
							</Button>
						</div>
						{parameters.length === 0 && (
							<p className='text-muted-foreground text-sm'>
								{t(prefix + 'none')}
							</p>
						)}
						{parameters.map((parameter, index) => (
							<div className='space-y-3 rounded-lg border p-3' key={index}>
								<div className='grid gap-3 sm:grid-cols-2'>
									<div className='space-y-2'>
										<Label htmlFor={'endpoint-image-param-' + index}>
											{t(prefix + 'parameterName')}
										</Label>
										<Input
											id={'endpoint-image-param-' + index}
											{...props.form.register(`image.parameters.${index}.name`)}
										/>
									</div>
									<div className='space-y-2'>
										<Label htmlFor={'endpoint-image-type-' + index}>
											{t(prefix + 'parameterType')}
										</Label>
										<select
											id={'endpoint-image-type-' + index}
											className={selectClass}
											{...props.form.register(`image.parameters.${index}.type`)}
										>
											<option value='boolean'>{t(prefix + 'boolean')}</option>
											<option value='enum'>{t(prefix + 'enum')}</option>
											<option value='range'>{t(prefix + 'range')}</option>
										</select>
									</div>
								</div>
								{parameter.type === 'enum' && (
									<div className='space-y-2'>
										<p className='text-sm font-medium'>
											{t(prefix + 'enumValues')}
										</p>
										{parameter.values.map((_value, valueIndex) => (
											<div className='flex gap-2' key={valueIndex}>
												<Input
													aria-label={t(prefix + 'enumValue', {
														index: valueIndex + 1,
													})}
													{...props.form.register(
														`image.parameters.${index}.values.${valueIndex}`
													)}
												/>
												<Button
													type='button'
													variant='outline'
													onClick={() => {
														const next = [...parameters]
														next[index] = {
															...parameter,
															values: parameter.values.filter(
																(_item, candidate) => candidate !== valueIndex
															),
														}
														setParameters(next)
													}}
												>
													{t(prefix + 'remove')}
												</Button>
											</div>
										))}
										<Button
											type='button'
											variant='outline'
											size='sm'
											onClick={() => {
												const next = [...parameters]
												next[index] = {
													...parameter,
													values: [...parameter.values, ''],
												}
												setParameters(next)
											}}
										>
											{t(prefix + 'addValue')}
										</Button>
									</div>
								)}
								{parameter.type === 'range' && (
									<div className='grid gap-3 sm:grid-cols-2'>
										<div className='space-y-2'>
											<Label htmlFor={'endpoint-image-min-' + index}>
												{t(prefix + 'minimum')}
											</Label>
											<Input
												id={'endpoint-image-min-' + index}
												type='number'
												{...props.form.register(
													`image.parameters.${index}.min`
												)}
											/>
										</div>
										<div className='space-y-2'>
											<Label htmlFor={'endpoint-image-max-' + index}>
												{t(prefix + 'maximum')}
											</Label>
											<Input
												id={'endpoint-image-max-' + index}
												type='number'
												{...props.form.register(
													`image.parameters.${index}.max`
												)}
											/>
										</div>
									</div>
								)}
								<Button
									type='button'
									variant='outline'
									size='sm'
									onClick={() =>
										setParameters(
											parameters.filter(
												(_item, candidate) => candidate !== index
											)
										)
									}
								>
									{t(prefix + 'removeParameter')}
								</Button>
							</div>
						))}
					</div>
					<div className='space-y-3 rounded-xl border p-4'>
						<div className='flex flex-wrap items-center justify-between gap-2'>
							<h4 className='font-medium'>{t(prefix + 'imagePricing')}</h4>
							<Button
								type='button'
								variant='outline'
								size='sm'
								onClick={() => setPrices([...prices, newPrice()])}
							>
								{t(prefix + 'addPrice')}
							</Button>
						</div>
						{prices.length === 0 && (
							<p className='text-muted-foreground text-sm'>
								{t(prefix + 'none')}
							</p>
						)}
						{prices.map((_price, index) => (
							<div
								className='grid gap-3 rounded-lg border p-3 sm:grid-cols-2 lg:grid-cols-4'
								key={index}
							>
								<div className='space-y-2'>
									<Label htmlFor={'endpoint-image-billable-' + index}>
										{t(prefix + 'billable')}
									</Label>
									<select
										id={'endpoint-image-billable-' + index}
										className={selectClass}
										{...props.form.register(`image.prices.${index}.billable`)}
									>
										{billables.map((value) => (
											<option value={value} key={value}>
												{t(prefix + 'billableName.' + value, {
													defaultValue: value,
												})}
											</option>
										))}
									</select>
								</div>
								<div className='space-y-2'>
									<Label htmlFor={'endpoint-image-unit-' + index}>
										{t(prefix + 'unit')}
									</Label>
									<select
										id={'endpoint-image-unit-' + index}
										className={selectClass}
										{...props.form.register(`image.prices.${index}.unit`)}
									>
										{units.map((value) => (
											<option value={value} key={value}>
												{t(prefix + 'unitName.' + value, {
													defaultValue: value,
												})}
											</option>
										))}
									</select>
								</div>
								<div className='space-y-2'>
									<Label htmlFor={'endpoint-image-cost-' + index}>
										{t(prefix + 'costUsd')}
									</Label>
									<Input
										id={'endpoint-image-cost-' + index}
										inputMode='decimal'
										{...props.form.register(`image.prices.${index}.cost_usd`)}
									/>
								</div>
								<div className='space-y-2'>
									<Label htmlFor={'endpoint-image-variant-' + index}>
										{t(prefix + 'variant')}
									</Label>
									<Input
										id={'endpoint-image-variant-' + index}
										{...props.form.register(`image.prices.${index}.variant`)}
									/>
								</div>
								<Button
									className='w-fit'
									type='button'
									variant='outline'
									size='sm'
									onClick={() =>
										setPrices(
											prices.filter((_item, candidate) => candidate !== index)
										)
									}
								>
									{t(prefix + 'removePrice')}
								</Button>
							</div>
						))}
					</div>
				</div>
			)}
		</section>
	)
}
