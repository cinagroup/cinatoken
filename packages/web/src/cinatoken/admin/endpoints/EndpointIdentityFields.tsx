/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Input } from '../../../components/ui/input'
import { Label } from '../../../components/ui/label'
import {
	ROUTE_QUANTIZATIONS,
	type EndpointChoices,
} from '../endpoint-contracts'
import type { EndpointFormValues } from './endpoint-form'

const prefix = 'cinatoken.adminEndpoints.'
const selectClass =
	'bg-background h-10 w-full min-w-0 rounded-md border px-3 text-sm'

export function EndpointIdentityFields(props: {
	form: UseFormReturn<EndpointFormValues>
	choices: EndpointChoices
	editing: boolean
}) {
	const { t } = useTranslation()
	return (
		<section className='space-y-4'>
			<h3 className='text-base font-semibold'>{t(prefix + 'identity')}</h3>
			<div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-3'>
				<div className='space-y-2'>
					<Label htmlFor='endpoint-model'>{t(prefix + 'model')}</Label>
					{props.editing ? (
						<Input
							id='endpoint-model'
							readOnly
							{...props.form.register('model_id')}
						/>
					) : (
						<select
							id='endpoint-model'
							className={selectClass}
							{...props.form.register('model_id')}
						>
							<option value=''>{t(prefix + 'selectModel')}</option>
							{props.choices.models.map((model) => (
								<option key={model.id} value={model.id}>
									{model.display_name || model.id}
								</option>
							))}
						</select>
					)}
				</div>
				<div className='space-y-2'>
					<Label htmlFor='endpoint-provider'>{t(prefix + 'provider')}</Label>
					{props.editing ? (
						<Input
							id='endpoint-provider'
							readOnly
							{...props.form.register('provider_id')}
						/>
					) : (
						<select
							id='endpoint-provider'
							className={selectClass}
							{...props.form.register('provider_id')}
						>
							<option value=''>{t(prefix + 'selectProvider')}</option>
							{props.choices.providers.map((provider) => (
								<option key={provider.id} value={provider.id}>
									{provider.name || provider.id}
								</option>
							))}
						</select>
					)}
				</div>
				<div className='space-y-2'>
					<Label htmlFor='endpoint-provider-slug'>
						{t(prefix + 'providerSlug')}
					</Label>
					<Input
						id='endpoint-provider-slug'
						{...props.form.register('provider_slug')}
					/>
				</div>
				<div className='space-y-2'>
					<Label htmlFor='endpoint-tag'>{t(prefix + 'tag')}</Label>
					<Input id='endpoint-tag' {...props.form.register('tag')} />
				</div>
				<div className='space-y-2'>
					<Label htmlFor='endpoint-class'>{t(prefix + 'endpointClass')}</Label>
					<select
						id='endpoint-class'
						className={selectClass}
						{...props.form.register('endpoint_class')}
					>
						<option value=''>{t(prefix + 'unknown')}</option>
						<option value='standard'>standard</option>
						<option value='service_tier'>service_tier</option>
					</select>
				</div>
				<div className='space-y-2'>
					<Label htmlFor='endpoint-region'>{t(prefix + 'region')}</Label>
					<Input id='endpoint-region' {...props.form.register('region')} />
				</div>
				{(
					[
						'context_length',
						'max_prompt_tokens',
						'max_completion_tokens',
					] as const
				).map((field) => (
					<div className='space-y-2' key={field}>
						<Label htmlFor={'endpoint-' + field}>{t(prefix + field)}</Label>
						<Input
							id={'endpoint-' + field}
							type='number'
							min={1}
							step={1}
							{...props.form.register(field)}
						/>
					</div>
				))}
				<div className='space-y-2'>
					<Label htmlFor='endpoint-quantization'>
						{t(prefix + 'quantization')}
					</Label>
					<select
						id='endpoint-quantization'
						className={selectClass}
						{...props.form.register('quantization')}
					>
						<option value=''>{t(prefix + 'unknown')}</option>
						{ROUTE_QUANTIZATIONS.map((value) => (
							<option key={value} value={value}>
								{value}
							</option>
						))}
					</select>
				</div>
			</div>
			<div className='space-y-2'>
				<Label htmlFor='endpoint-parameters'>
					{t(prefix + 'supportedParameters')}
				</Label>
				<Input
					id='endpoint-parameters'
					{...props.form.register('supported_parameters')}
					placeholder='temperature, tools, tool_choice'
				/>
				<p className='text-muted-foreground text-xs'>
					{t(prefix + 'supportedParametersHint')}
				</p>
			</div>
		</section>
	)
}
