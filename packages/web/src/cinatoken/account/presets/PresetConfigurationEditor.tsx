import { useState } from 'react'
import { useWatch, type UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
	changePresetField,
	parsePresetNumber,
	readPresetConfig,
} from './preset-config-editor'
import type { PresetForm } from './preset-form'

const prefix = 'cinatoken.presets.'
const numericFields = [
	['temperature', 'temperature'],
	['top_p', 'topP'],
	['max_tokens', 'maxTokens'],
	['max_completion_tokens', 'maxCompletionTokens'],
	['max_output_tokens', 'maxOutputTokens'],
] as const
const providerLists = [
	['order', 'providerOrder'],
	['only', 'providerOnly'],
	['ignore', 'providerIgnore'],
] as const
const providerFlags = [
	['allow_fallbacks', 'allowFallbacks'],
	['require_parameters', 'requireParameters'],
	['zdr', 'zdr'],
] as const
const selectClass = 'bg-background h-10 w-full rounded-lg border px-3 text-sm'

export function PresetConfigurationEditor(props: {
	form: UseFormReturn<PresetForm>
}) {
	const { t } = useTranslation()
	const text = useWatch({ control: props.form.control, name: 'configText' })
	const config = readPresetConfig(text)
	const provider = config?.provider
	const preferences =
		provider && typeof provider === 'object' && !Array.isArray(provider)
			? (provider as Record<string, unknown>)
			: {}
	const [drafts, setDrafts] = useState<Record<string, string>>({})
	const [invalid, setInvalid] = useState<Record<string, boolean>>({})
	function change(key: string, value: unknown, inProvider = false) {
		if (!config) return
		props.form.setValue(
			'configText',
			changePresetField(config, key, value, inProvider),
			{ shouldDirty: true, shouldValidate: true }
		)
	}
	function number(key: string, value: string) {
		setDrafts((current) => ({ ...current, [key]: value }))
		const parsed = parsePresetNumber(value)
		const nextInvalid = { ...invalid, [key]: !parsed.valid }
		setInvalid(nextInvalid)
		props.form.setValue(
			'guidedValid',
			!Object.values(nextInvalid).some(Boolean),
			{ shouldValidate: true }
		)
		if (parsed.valid) change(key, parsed.value)
	}
	return (
		<section className='space-y-4' aria-labelledby='preset-config-title'>
			<h3 id='preset-config-title' className='font-medium'>
				{t(prefix + 'configuration')}
			</h3>
			{!config && (
				<p className='text-muted-foreground text-sm'>
					{t(prefix + 'configInvalid')}
				</p>
			)}
			<fieldset disabled={!config} className='grid gap-4 sm:grid-cols-2'>
				<div className='space-y-2'>
					<Label htmlFor='preset-model'>{t(prefix + 'model')}</Label>
					<Input
						id='preset-model'
						value={typeof config?.model === 'string' ? config.model : ''}
						onChange={(event) =>
							change('model', event.target.value || undefined)
						}
					/>
				</div>
				{numericFields.map(([key, label]) => (
					<div key={key} className='space-y-2'>
						<Label htmlFor={'preset-' + key}>{t(prefix + label)}</Label>
						<Input
							id={'preset-' + key}
							inputMode='decimal'
							value={
								drafts[key] ??
								(typeof config?.[key] === 'number' ? String(config[key]) : '')
							}
							onChange={(event) => number(key, event.target.value)}
							aria-invalid={invalid[key] || undefined}
						/>
						{invalid[key] && (
							<p role='alert' className='text-destructive text-xs'>
								{t(prefix + 'validation.number')}
							</p>
						)}
					</div>
				))}
			</fieldset>
			<fieldset disabled={!config} className='space-y-3 rounded-lg border p-3'>
				<legend className='px-1 text-sm font-medium'>
					{t(prefix + 'providerPreferences')}
				</legend>
				<p className='text-muted-foreground text-xs'>
					{t(prefix + 'providerNamesHint')}
				</p>
				<div className='grid gap-3 sm:grid-cols-3'>
					{providerLists.map(([key, label]) => (
						<div key={key} className='space-y-2'>
							<Label htmlFor={'preset-provider-' + key}>
								{t(prefix + label)}
							</Label>
							<Input
								id={'preset-provider-' + key}
								value={
									Array.isArray(preferences[key])
										? preferences[key].join(', ')
										: ''
								}
								onChange={(event) =>
									change(
										key,
										event.target.value
											? event.target.value
													.split(/[,\n]/u)
													.map((name) => name.trim())
													.filter(Boolean)
											: undefined,
										true
									)
								}
							/>
						</div>
					))}
					{providerFlags.map(([key, label]) => (
						<div key={key} className='space-y-2'>
							<Label htmlFor={'preset-provider-' + key}>
								{t(prefix + label)}
							</Label>
							<select
								id={'preset-provider-' + key}
								className={selectClass}
								value={
									typeof preferences[key] === 'boolean'
										? String(preferences[key])
										: ''
								}
								onChange={(event) =>
									change(
										key,
										event.target.value === ''
											? undefined
											: event.target.value === 'true',
										true
									)
								}
							>
								<option value=''>{t(prefix + 'inherit')}</option>
								<option value='true'>{t(prefix + 'yes')}</option>
								<option value='false'>{t(prefix + 'no')}</option>
							</select>
						</div>
					))}
					<div className='space-y-2'>
						<Label htmlFor='preset-data-collection'>
							{t(prefix + 'dataCollection')}
						</Label>
						<select
							id='preset-data-collection'
							className={selectClass}
							value={
								typeof preferences.data_collection === 'string'
									? preferences.data_collection
									: ''
							}
							onChange={(event) =>
								change('data_collection', event.target.value || undefined, true)
							}
						>
							<option value=''>{t(prefix + 'inherit')}</option>
							<option value='allow'>{t(prefix + 'allow')}</option>
							<option value='deny'>{t(prefix + 'deny')}</option>
						</select>
					</div>
				</div>
			</fieldset>
			<div className='space-y-2'>
				<Label htmlFor='preset-config'>{t(prefix + 'advanced')}</Label>
				<p
					id='preset-config-hint'
					className='text-muted-foreground text-xs leading-5'
				>
					{t(prefix + 'advancedHint')}
				</p>
				<Textarea
					id='preset-config'
					rows={12}
					className='font-mono text-xs'
					spellCheck={false}
					aria-describedby='preset-config-hint preset-config-error'
					aria-invalid={Boolean(props.form.formState.errors.configText)}
					{...props.form.register('configText', {
						onChange: () => {
							setDrafts({})
							setInvalid({})
							props.form.setValue('guidedValid', true)
						},
					})}
				/>
				{props.form.formState.errors.configText?.message && (
					<p
						id='preset-config-error'
						role='alert'
						className='text-destructive text-xs'
					>
						{t(props.form.formState.errors.configText.message)}
					</p>
				)}
			</div>
		</section>
	)
}
