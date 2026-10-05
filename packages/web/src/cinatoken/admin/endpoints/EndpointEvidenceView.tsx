/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import type { AdminEndpoint } from '../endpoint-contracts'

const prefix = 'cinatoken.adminEndpoints.'

function value(value: unknown): string {
	if (value === null || value === undefined) return '—'
	if (typeof value === 'boolean') return value ? '✓' : '✕'
	return String(value)
}

export function EndpointEvidenceView(props: { row: AdminEndpoint }) {
	const { t } = useTranslation()
	const image = props.row.image_capabilities
	const audio = props.row.audio_capabilities
	return (
		<div className='space-y-5'>
			<section className='space-y-2 rounded-xl border p-4'>
				<h3 className='font-semibold'>{t(prefix + 'textPricing')}</h3>
				{!props.row.pricing && (
					<p className='text-muted-foreground text-sm'>{t(prefix + 'none')}</p>
				)}
				{props.row.pricing && (
					<dl className='grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3'>
						{Object.entries(props.row.pricing)
							.filter(
								([field, price]) => field !== 'currency' && price !== undefined
							)
							.map(([field, price]) => (
								<div key={field} className='min-w-0'>
									<dt className='text-muted-foreground'>
										{t(prefix + 'price.' + field, { defaultValue: field })} ·
										USD
									</dt>
									<dd className='font-mono break-all'>{value(price)}</dd>
								</div>
							))}
					</dl>
				)}
			</section>
			<section className='space-y-3 rounded-xl border p-4'>
				<h3 className='font-semibold'>{t(prefix + 'imageCapabilities')}</h3>
				{!image && (
					<p className='text-muted-foreground text-sm'>{t(prefix + 'none')}</p>
				)}
				{image && (
					<>
						<p className='text-sm'>
							{t(prefix + 'imageProviderTag')}: {value(image.provider_tag)} ·{' '}
							{t(prefix + 'streaming')}: {value(image.supports_streaming)}
						</p>
						<p className='text-muted-foreground text-xs break-all'>
							{t(prefix + 'imagePassthrough')}:{' '}
							{image.allowed_passthrough_parameters.join(', ') || '—'}
						</p>
						{Object.entries(image.supported_parameters).map(
							([name, descriptor]) => (
								<div key={name} className='text-sm break-all'>
									<span className='font-mono'>{name}</span> ·{' '}
									{t(prefix + descriptor.type)}
									{descriptor.type === 'enum' &&
										` · ${descriptor.values.join(', ')}`}
									{descriptor.type === 'range' &&
										` · ${descriptor.min}–${descriptor.max}`}
								</div>
							)
						)}
						{image.pricing.length > 0 && (
							<div className='space-y-1 border-t pt-3 text-sm'>
								{image.pricing.map((line, index) => (
									<p key={index} className='break-all'>
										{t(prefix + 'billableName.' + line.billable, {
											defaultValue: line.billable,
										})}{' '}
										· {line.variant || '—'} · {line.cost_usd} USD /{' '}
										{t(prefix + 'unitName.' + line.unit, {
											defaultValue: line.unit,
										})}
									</p>
								))}
							</div>
						)}
					</>
				)}
			</section>
			<section className='space-y-3 rounded-xl border p-4'>
				<h3 className='font-semibold'>{t(prefix + 'audioCapabilities')}</h3>
				{!audio && (
					<p className='text-muted-foreground text-sm'>{t(prefix + 'none')}</p>
				)}
				{audio && (
					<>
						{Object.entries(audio.pricing_by_operation).map(
							([operation, pricing]) => {
								if (!pricing) return null
								return (
									<div
										key={operation}
										className='space-y-1 border-t pt-3 text-sm'
									>
										<p className='font-mono break-all'>
											{operation} · {t(prefix + pricing.meter.kind)}
										</p>
										{pricing.meter.kind === 'tokens' ? (
											<p className='font-mono break-all'>
												{Object.entries(pricing.meter.rates)
													.map(([field, rate]) => `${field}: ${rate}`)
													.join(' · ')}
											</p>
										) : (
											<p>
												{pricing.meter.price} USD /{' '}
												{t(prefix + pricing.meter.kind)} ·{' '}
												{t(prefix + 'minimumUnits')}:{' '}
												{pricing.meter.minimum_units} ·{' '}
												{t(prefix + 'incrementUnits')}:{' '}
												{pricing.meter.increment_units}
											</p>
										)}
										<p className='text-muted-foreground'>
											{t(prefix + 'requestPriceUsd')}: {value(pricing.request)}{' '}
											· {t(prefix + 'discount')}: {value(pricing.discount)}
										</p>
									</div>
								)
							}
						)}
						{audio.speech_by_operation?.['audio.speech'] && (
							<p className='text-sm break-all'>
								{t(prefix + 'speechEvidence')}: {t(prefix + 'defaultVoice')}{' '}
								{value(
									audio.speech_by_operation['audio.speech']
										.supports_default_voice
								)}{' '}
								· {t(prefix + 'referenceTypes')}{' '}
								{audio.speech_by_operation[
									'audio.speech'
								].reference_audio_media_types.join(', ') || '—'}
							</p>
						)}
					</>
				)}
			</section>
		</div>
	)
}
