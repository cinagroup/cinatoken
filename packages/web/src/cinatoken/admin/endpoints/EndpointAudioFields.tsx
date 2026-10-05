/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import { Label } from '../../../components/ui/label'
import { AUDIO_ENDPOINT_PRICING_OPERATIONS } from '../endpoint-contracts'
import {
	AUDIO_RATE_FIELDS,
	audioMeterKinds,
	newAudioOperation,
	type AudioOperationDraft,
	type EndpointFormValues,
} from './endpoint-form'

const prefix = 'cinatoken.adminEndpoints.'
const selectClass =
	'bg-background h-10 w-full min-w-0 rounded-md border px-3 text-sm'

export function EndpointAudioFields(props: {
	form: UseFormReturn<EndpointFormValues>
}) {
	const { t } = useTranslation()
	const enabled = props.form.watch('audio.enabled')
	const operations = props.form.watch('audio.operations')
	const speechEnabled = props.form.watch('audio.speechEnabled')
	function setOperations(next: AudioOperationDraft[]): void {
		props.form.setValue('audio.operations', next, { shouldDirty: true })
	}
	function addOperation(): void {
		const available = AUDIO_ENDPOINT_PRICING_OPERATIONS.find(
			(item) => !operations.some((entry) => entry.operation === item)
		)
		if (available) setOperations([...operations, newAudioOperation(available)])
	}
	return (
		<section className='space-y-4'>
			<h3 className='text-base font-semibold'>
				{t(prefix + 'audioCapabilities')}
			</h3>
			<label className='flex items-center gap-2 text-sm'>
				<input type='checkbox' {...props.form.register('audio.enabled')} />
				{t(prefix + 'audioEnabled')}
			</label>
			{enabled && (
				<div className='space-y-5'>
					<p className='text-muted-foreground text-xs'>
						{t(prefix + 'audioPricingHint')}
					</p>
					<div className='flex flex-wrap items-center justify-between gap-2'>
						<h4 className='font-medium'>{t(prefix + 'audioOperations')}</h4>
						<Button
							type='button'
							variant='outline'
							size='sm'
							disabled={
								operations.length >= AUDIO_ENDPOINT_PRICING_OPERATIONS.length
							}
							onClick={addOperation}
						>
							{t(prefix + 'addOperation')}
						</Button>
					</div>
					{operations.length === 0 && (
						<p className='text-muted-foreground text-sm'>
							{t(prefix + 'audioOperationRequired')}
						</p>
					)}
					{operations.map((operation, index) => (
						<div className='space-y-4 rounded-xl border p-4' key={index}>
							<div className='grid gap-3 sm:grid-cols-2'>
								<div className='space-y-2'>
									<Label htmlFor={'endpoint-audio-operation-' + index}>
										{t(prefix + 'operation')}
									</Label>
									<select
										id={'endpoint-audio-operation-' + index}
										className={selectClass}
										{...props.form.register(
											`audio.operations.${index}.operation`,
											{
												onChange: (event) => {
													const next = event.target
														.value as AudioOperationDraft['operation']
													props.form.setValue(
														`audio.operations.${index}.kind`,
														audioMeterKinds(next)[0]!,
														{ shouldDirty: true }
													)
												},
											}
										)}
									>
										{AUDIO_ENDPOINT_PRICING_OPERATIONS.map((value) => (
											<option value={value} key={value}>
												{value}
											</option>
										))}
									</select>
								</div>
								<div className='space-y-2'>
									<Label htmlFor={'endpoint-audio-kind-' + index}>
										{t(prefix + 'meterKind')}
									</Label>
									<select
										id={'endpoint-audio-kind-' + index}
										className={selectClass}
										{...props.form.register(`audio.operations.${index}.kind`)}
									>
										{audioMeterKinds(operation.operation).map((kind) => (
											<option value={kind} key={kind}>
												{t(prefix + kind)}
											</option>
										))}
									</select>
								</div>
							</div>
							{operation.kind === 'tokens' ? (
								<div className='space-y-3'>
									<p className='text-muted-foreground text-xs'>
										{t(prefix + 'authoritativeBreakdown')}
									</p>
									<div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-3'>
										{AUDIO_RATE_FIELDS.map((field) => (
											<div key={field} className='space-y-2'>
												<Label htmlFor={`endpoint-audio-${index}-${field}`}>
													{t(prefix + 'audioRate.' + field, {
														defaultValue: field,
													})}
												</Label>
												<Input
													id={`endpoint-audio-${index}-${field}`}
													inputMode='decimal'
													{...props.form.register(
														`audio.operations.${index}.rates.${field}`
													)}
												/>
											</div>
										))}
									</div>
								</div>
							) : (
								<div className='grid gap-3 sm:grid-cols-3'>
									<div className='space-y-2'>
										<Label htmlFor={'endpoint-audio-price-' + index}>
											{t(prefix + 'meterPriceUsd')}
										</Label>
										<Input
											id={'endpoint-audio-price-' + index}
											inputMode='decimal'
											{...props.form.register(
												`audio.operations.${index}.price`
											)}
										/>
									</div>
									<div className='space-y-2'>
										<Label htmlFor={'endpoint-audio-min-' + index}>
											{t(prefix + 'minimumUnits')}
										</Label>
										<Input
											id={'endpoint-audio-min-' + index}
											type='number'
											min={0}
											step={1}
											{...props.form.register(
												`audio.operations.${index}.minimum`
											)}
										/>
									</div>
									<div className='space-y-2'>
										<Label htmlFor={'endpoint-audio-increment-' + index}>
											{t(prefix + 'incrementUnits')}
										</Label>
										<Input
											id={'endpoint-audio-increment-' + index}
											type='number'
											min={1}
											step={1}
											{...props.form.register(
												`audio.operations.${index}.increment`
											)}
										/>
									</div>
								</div>
							)}
							<div className='grid gap-3 sm:grid-cols-2'>
								<div className='space-y-2'>
									<Label htmlFor={'endpoint-audio-request-' + index}>
										{t(prefix + 'requestPriceUsd')}
									</Label>
									<Input
										id={'endpoint-audio-request-' + index}
										inputMode='decimal'
										{...props.form.register(
											`audio.operations.${index}.request`
										)}
									/>
								</div>
								<div className='space-y-2'>
									<Label htmlFor={'endpoint-audio-discount-' + index}>
										{t(prefix + 'discount')}
									</Label>
									<Input
										id={'endpoint-audio-discount-' + index}
										inputMode='decimal'
										{...props.form.register(
											`audio.operations.${index}.discount`
										)}
									/>
								</div>
							</div>
							<Button
								type='button'
								variant='outline'
								size='sm'
								onClick={() =>
									setOperations(
										operations.filter((_item, candidate) => candidate !== index)
									)
								}
							>
								{t(prefix + 'removeOperation')}
							</Button>
						</div>
					))}
					<div className='space-y-4 rounded-xl border p-4'>
						<label className='flex items-center gap-2 text-sm'>
							<input
								type='checkbox'
								{...props.form.register('audio.speechEnabled')}
							/>
							{t(prefix + 'speechEvidence')}
						</label>
						{speechEnabled && (
							<div className='grid gap-3 sm:grid-cols-2'>
								<div className='space-y-2'>
									<Label htmlFor='endpoint-default-voice'>
										{t(prefix + 'defaultVoice')}
									</Label>
									<select
										id='endpoint-default-voice'
										className={selectClass}
										{...props.form.register('audio.defaultVoice')}
									>
										<option value='unknown'>{t(prefix + 'unknown')}</option>
										<option value='true'>{t(prefix + 'supported')}</option>
										<option value='false'>{t(prefix + 'unsupported')}</option>
									</select>
								</div>
								<div className='space-y-2'>
									<Label htmlFor='endpoint-reference-types'>
										{t(prefix + 'referenceTypes')}
									</Label>
									<Input
										id='endpoint-reference-types'
										{...props.form.register('audio.referenceTypes')}
										placeholder='audio/wav, audio/mpeg'
									/>
								</div>
								<div className='space-y-2'>
									<Label htmlFor='endpoint-reference-default'>
										{t(prefix + 'defaultReferenceType')}
									</Label>
									<Input
										id='endpoint-reference-default'
										{...props.form.register('audio.defaultReferenceType')}
										placeholder='audio/wav'
									/>
								</div>
								<p className='text-muted-foreground text-xs sm:col-span-2'>
									{t(prefix + 'speechEvidenceHint')}
								</p>
							</div>
						)}
					</div>
				</div>
			)}
		</section>
	)
}
