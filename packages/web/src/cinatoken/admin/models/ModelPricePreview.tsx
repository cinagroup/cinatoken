/** @jsxRuntime automatic */
import { useTranslation } from 'react-i18next'
import type { AdminModel } from '../model-contracts'

/** A compact numeric preview, deliberately without an invented currency label. */
export function ModelPricePreview(props: { row: AdminModel }) {
	const { t } = useTranslation()
	const prefix = 'cinatoken.adminModels.'
	const profile = props.row.pricing.profile
	if (!profile)
		return (
			<p className='text-destructive text-xs'>
				{t(prefix + 'pricing_' + props.row.pricing.state)}
			</p>
		)
	if (props.row.pricing.imageBillingMode === 'per_image' && profile.image)
		return (
			<p className='text-sm tabular-nums'>
				{t(prefix + 'per_image')}: {profile.image.default}
			</p>
		)
	if (props.row.pricing.audioBillingMode === 'per_second' && profile.audio)
		return (
			<p className='text-sm tabular-nums'>
				{t(prefix + 'secondPrice')}: {profile.audio.price_per_second}
			</p>
		)
	if (props.row.pricing.audioBillingMode === 'per_character' && profile.audio)
		return (
			<p className='text-sm tabular-nums'>
				{t(prefix + 'characterPrice')}: {profile.audio.price_per_character}
			</p>
		)
	const tier = profile.tiers[0]
	if (!tier) return null
	return (
		<div className='space-y-1 text-xs'>
			<p className='tabular-nums'>
				{t(prefix + 'input_price')}: {tier.input_price} ·{' '}
				{t(prefix + 'output_price')}: {tier.output_price}
			</p>
			{(
				[
					'image_input_price',
					'image_input_cache_price',
					'image_output_price',
				] as const
			).map(
				(field) =>
					tier[field] !== null && (
						<p key={field} className='tabular-nums'>
							{t(prefix + field)}: {tier[field]}
						</p>
					)
			)}
			<p className='text-muted-foreground'>
				{t(prefix + 'tokenPreview', { count: profile.tiers.length })}
			</p>
		</div>
	)
}
