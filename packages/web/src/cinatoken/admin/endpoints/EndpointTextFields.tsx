/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Input } from '../../../components/ui/input'
import { Label } from '../../../components/ui/label'
import {
	ENDPOINT_PRICE_FIELDS,
	ENDPOINT_TRAITS,
	type EndpointFormValues,
} from './endpoint-form'

const prefix = 'cinatoken.adminEndpoints.'
const selectClass =
	'bg-background h-10 w-full min-w-0 rounded-md border px-3 text-sm'

export function EndpointTextFields(props: {
	form: UseFormReturn<EndpointFormValues>
}) {
	const { t } = useTranslation()
	const pricingEnabled = props.form.watch('pricingEnabled')
	return (
		<div className='space-y-6'>
			<section className='space-y-4'>
				<h3 className='text-base font-semibold'>{t(prefix + 'textPricing')}</h3>
				<label className='flex items-center gap-2 text-sm'>
					<input type='checkbox' {...props.form.register('pricingEnabled')} />
					{t(prefix + 'textPricingEnabled')}
				</label>
				{pricingEnabled && (
					<div className='space-y-3'>
						<p className='text-muted-foreground text-xs'>
							{t(prefix + 'pricingUsdHint')}
						</p>
						<div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-3'>
							{ENDPOINT_PRICE_FIELDS.map((field) => (
								<div className='space-y-2' key={field}>
									<Label htmlFor={'endpoint-price-' + field}>
										{t(prefix + 'price.' + field, { defaultValue: field })}
									</Label>
									<Input
										id={'endpoint-price-' + field}
										inputMode='decimal'
										{...props.form.register(`prices.${field}`)}
										placeholder={field === 'discount' ? '0.5' : '0.000001'}
									/>
								</div>
							))}
						</div>
					</div>
				)}
			</section>
			<section className='space-y-4'>
				<h3 className='text-base font-semibold'>
					{t(prefix + 'capabilities')}
				</h3>
				<div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-3'>
					{ENDPOINT_TRAITS.map((trait) => (
						<div className='space-y-2' key={trait}>
							<Label htmlFor={'endpoint-trait-' + trait}>
								{t(prefix + 'trait.' + trait, { defaultValue: trait })}
							</Label>
							<select
								id={'endpoint-trait-' + trait}
								className={selectClass}
								{...props.form.register(`traits.${trait}`)}
							>
								<option value='unknown'>{t(prefix + 'unknown')}</option>
								<option value='true'>{t(prefix + 'supported')}</option>
								<option value='false'>{t(prefix + 'unsupported')}</option>
							</select>
						</div>
					))}
				</div>
			</section>
		</div>
	)
}
