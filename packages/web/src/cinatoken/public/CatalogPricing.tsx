import type { CatalogPricing } from './catalog-contracts'
import {
	formatMoney,
	imageTokenMode,
	priceOverview,
} from './catalog-view-model'
import type { PublicMessages } from './messages'
import { usePublicText } from './use-public-catalog'

const unitKeys = {
	token: 'tokenUnit',
	image: 'imageUnit',
	second: 'secondUnit',
	character: 'characterUnit',
} as const
export function PriceSummary(props: {
	profile: CatalogPricing | null
	currency: string
}) {
	const { text, locale } = usePublicText()
	const prices = priceOverview(props.profile)
	if (!prices.length)
		return (
			<span className='text-muted-foreground text-xs'>{text('noPricing')}</span>
		)
	return (
		<div className='space-y-1 text-xs'>
			{prices.map((row) => (
				<div key={row.unit} className='flex flex-wrap gap-x-2 gap-y-1'>
					<span className='font-medium tabular-nums'>
						{row.input !== null && row.output !== null
							? `${text('inputPrice')}: `
							: ''}
						{row.input !== null
							? formatMoney(row.input, props.currency, locale)
							: formatMoney(row.output!, props.currency, locale)}
						{row.input !== null && row.output !== null
							? ` / ${text('outputPrice')}: ${formatMoney(row.output, props.currency, locale)}`
							: ''}
					</span>
					<span className='text-muted-foreground'>
						{text(unitKeys[row.unit])}
					</span>
				</div>
			))}
		</div>
	)
}
function PriceValue(props: { value: number | null; currency: string }) {
	const { text, locale } = usePublicText()
	return (
		<span className='font-medium break-words tabular-nums'>
			{props.value === null
				? text('unknown')
				: formatMoney(props.value, props.currency, locale)}
		</span>
	)
}
function PriceMap(props: {
	label: keyof PublicMessages
	values: Record<string, number> | undefined
	currency: string
}) {
	const { text } = usePublicText()
	if (!props.values || !Object.keys(props.values).length) return null
	return (
		<div className='space-y-2'>
			<h4 className='text-muted-foreground text-xs font-medium'>
				{text(props.label)}
			</h4>
			<dl className='space-y-2 text-sm'>
				{Object.entries(props.values).map(([key, value]) => (
					<div
						key={key}
						className='flex flex-wrap justify-between gap-x-4 gap-y-1'
					>
						<dt className='min-w-0 break-all'>{key}</dt>
						<dd>
							<PriceValue value={value} currency={props.currency} />
						</dd>
					</div>
				))}
			</dl>
		</div>
	)
}
type ImageSide = NonNullable<CatalogPricing['image']>
function ImagePrices(props: {
	side: ImageSide | NonNullable<ImageSide['input']>
	currency: string
}) {
	const { text } = usePublicText()
	return (
		<div className='space-y-4'>
			<dl className='text-sm'>
				<div className='flex flex-wrap justify-between gap-3'>
					<dt>{text('defaultPrice')}</dt>
					<dd>
						<PriceValue value={props.side.default} currency={props.currency} />
					</dd>
				</div>
			</dl>
			<PriceMap
				label='quality'
				values={props.side.by_quality}
				currency={props.currency}
			/>
			<PriceMap
				label='size'
				values={props.side.by_size}
				currency={props.currency}
			/>
			<PriceMap
				label='qualitySize'
				values={props.side.by_quality_size}
				currency={props.currency}
			/>
		</div>
	)
}
export function PricingDetails(props: {
	profile: CatalogPricing | null
	currency: string
}) {
	const { text, locale } = usePublicText()
	const profile = props.profile
	if (!profile)
		return <p className='text-muted-foreground text-sm'>{text('noPricing')}</p>
	const activeToken =
		profile.image_billing_mode !== 'per_image' &&
		profile.audio_billing_mode !== 'per_second' &&
		profile.audio_billing_mode !== 'per_character'
	const tokenFields = [
		['input_price', 'inputPrice'],
		['output_price', 'outputPrice'],
		['cache_read_price', 'cacheRead'],
		['cache_write_price', 'cacheWrite'],
	] as const
	const imageFields = [
		['image_input_price', 'imageInput'],
		['image_input_cache_price', 'imageCache'],
		['image_output_price', 'imageOutput'],
	] as const
	const showImageFields =
		imageTokenMode(profile) ||
		profile.tiers.some((tier) =>
			imageFields.some(([field]) => tier[field] !== null)
		)
	return (
		<div className='space-y-5'>
			<p className='text-muted-foreground text-xs leading-5'>
				{text('priceNote', { currency: props.currency })}
			</p>
			{priceOverview(profile).length === 0 ? (
				<p className='text-muted-foreground text-sm'>{text('noPricing')}</p>
			) : null}
			{activeToken && showImageFields && !imageTokenMode(profile) ? (
				<p className='text-muted-foreground text-xs'>
					{text('inactiveImageTokens')}
				</p>
			) : null}
			{activeToken
				? [...profile.tiers]
						.sort((a, b) => (a.upto ?? Infinity) - (b.upto ?? Infinity))
						.map((tier, index) => (
							<section key={index} className='space-y-3 rounded-lg border p-3'>
								<h3 className='text-sm font-semibold'>
									{tier.label || text('tier', { number: index + 1 })}
								</h3>
								<p className='text-muted-foreground text-xs'>
									{tier.upto === null
										? text('unlimited')
										: text('tierBound', {
												bound: new Intl.NumberFormat(locale).format(tier.upto),
											})}{' '}
									· {text('tokenUnit')}
								</p>
								<dl className='space-y-2 text-sm'>
									{[
										...tokenFields,
										...(showImageFields ? imageFields : []),
									].map(([field, label]) => (
										<div
											key={field}
											className='flex flex-wrap justify-between gap-x-4 gap-y-1'
										>
											<dt className='text-muted-foreground'>{text(label)}</dt>
											<dd>
												<PriceValue
													value={tier[field]}
													currency={props.currency}
												/>
											</dd>
										</div>
									))}
								</dl>
							</section>
						))
				: null}
			{profile.image_billing_mode === 'per_image' && profile.image ? (
				<section className='space-y-4 rounded-lg border p-3'>
					<h3 className='font-semibold'>{text('imageUnit')}</h3>
					<ImagePrices side={profile.image} currency={props.currency} />
					{profile.image.input ? (
						<div className='space-y-3 border-t pt-3'>
							<h4 className='text-sm font-semibold'>
								{text('referenceImages')}
							</h4>
							<ImagePrices
								side={profile.image.input}
								currency={props.currency}
							/>
						</div>
					) : null}
					<p className='text-muted-foreground text-xs'>
						{text('uncertain')}:{' '}
						{text(
							profile.image.uncertain_result_policy === 'zero'
								? 'zero'
								: 'requested'
						)}
					</p>
				</section>
			) : null}
			{profile.image &&
			profile.image_billing_mode === undefined &&
			!imageTokenMode(profile) ? (
				<p className='text-muted-foreground text-xs'>{text('legacyImage')}</p>
			) : null}
			{profile.audio_billing_mode === 'per_second' &&
			profile.audio &&
			'price_per_second' in profile.audio ? (
				<section className='space-y-3 rounded-lg border p-3'>
					<h3 className='font-semibold'>{text('secondUnit')}</h3>
					<PriceValue
						value={profile.audio.price_per_second}
						currency={props.currency}
					/>
					<p className='text-muted-foreground text-xs'>
						{text('minimumSeconds', {
							count: profile.audio.minimum_seconds ?? 1,
						})}
					</p>
				</section>
			) : null}
			{profile.audio_billing_mode === 'per_character' &&
			profile.audio &&
			'price_per_character' in profile.audio ? (
				<section className='space-y-3 rounded-lg border p-3'>
					<h3 className='font-semibold'>{text('characterUnit')}</h3>
					<PriceValue
						value={profile.audio.price_per_character}
						currency={props.currency}
					/>
					<p className='text-muted-foreground text-xs'>
						{text('minimumCharacters', {
							count: profile.audio.minimum_characters ?? 0,
						})}
					</p>
				</section>
			) : null}
		</div>
	)
}
