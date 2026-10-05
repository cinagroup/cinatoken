import { useState } from 'react'
import { z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import { Label } from '../../../components/ui/label'
import { Textarea } from '../../../components/ui/textarea'
import type {
	ProviderDashScopeResource,
	ProviderJsonObject,
} from '../provider-contracts'
import { providerDashScopeInput } from '../provider-input'
import type { ProviderDashScopeResult } from '../provider-resource'

const prefix = 'cinatoken.adminProviders.'
const schema = z.object({
	text: z.string().superRefine((value, context) => {
		try {
			providerDashScopeInput(JSON.parse(value) as ProviderJsonObject)
		} catch {
			context.addIssue({ code: 'custom', message: prefix + 'invalidJson' })
		}
	}),
})
export function ProviderResourceForm(props: {
	pending: boolean
	disabled: boolean
	response: ProviderDashScopeResult | null
	onSend: (
		resource: ProviderDashScopeResource,
		input: ProviderJsonObject
	) => void
}) {
	const { t } = useTranslation()
	const [resource, setResource] =
		useState<ProviderDashScopeResource>('hotwords')
	const [review, setReview] = useState<ProviderJsonObject | null>(null)
	const form = useForm<{ text: string }>({
		resolver: zodResolver(schema),
		defaultValues: {
			text: JSON.stringify(
				{ model: 'speech-biasing', input: { action: 'list_vocabulary' } },
				null,
				2
			),
		},
	})
	return (
		<section className='space-y-4 border-t pt-4'>
			<h3 className='font-semibold'>{t(prefix + 'diagnostics')}</h3>
			<p className='text-muted-foreground text-sm'>
				{t(prefix + 'diagnosticsHint')}
			</p>
			{!review && (
				<form
					className='space-y-4'
					onSubmit={form.handleSubmit((values) =>
						setReview(
							providerDashScopeInput(
								JSON.parse(values.text) as ProviderJsonObject
							)
						)
					)}
				>
					<fieldset
						disabled={props.disabled || props.pending}
						className='space-y-4'
					>
						<div className='space-y-2'>
							<Label htmlFor='provider-resource'>
								{t(prefix + 'resource')}
							</Label>
							<select
								id='provider-resource'
								value={resource}
								onChange={(event) => {
									const value = event.target.value as ProviderDashScopeResource
									setResource(value)
									form.setValue(
										'text',
										JSON.stringify(
											{
												model:
													value === 'voices'
														? 'voice-enrollment'
														: 'speech-biasing',
												input: {
													action:
														value === 'voices'
															? 'list_voice'
															: 'list_vocabulary',
												},
											},
											null,
											2
										)
									)
								}}
								className='bg-background h-10 w-full rounded-md border px-3'
							>
								<option value='hotwords'>{t(prefix + 'hotwords')}</option>
								<option value='voices'>{t(prefix + 'voices')}</option>
							</select>
						</div>
						<div className='space-y-2'>
							<Label htmlFor='provider-resource-json'>
								{t(prefix + 'requestJson')}
							</Label>
							<Textarea
								id='provider-resource-json'
								{...form.register('text')}
								rows={8}
								autoComplete='off'
								spellCheck={false}
								className='font-mono text-xs'
							/>
							{form.formState.errors.text?.message && (
								<p role='alert' className='text-destructive text-xs'>
									{t(form.formState.errors.text.message)}
								</p>
							)}
						</div>
						<Button type='submit'>{t(prefix + 'sendResource')}</Button>
					</fieldset>
				</form>
			)}
			{review && (
				<div className='space-y-4'>
					<p className='font-medium'>{t(prefix + 'resourceReview')}</p>
					<pre className='bg-muted max-h-64 overflow-auto rounded-md p-3 text-xs break-all whitespace-pre-wrap'>
						{JSON.stringify(review, null, 2)}
					</pre>
					<div className='flex flex-wrap gap-2'>
						<Button
							variant='outline'
							disabled={props.pending}
							onClick={() => setReview(null)}
						>
							{t(prefix + 'cancel')}
						</Button>
						<Button
							disabled={props.disabled || props.pending}
							onClick={() => {
								const input = review
								setReview(null)
								form.reset({ text: '' })
								props.onSend(resource, input)
							}}
						>
							{t(prefix + 'confirm')}
						</Button>
					</div>
				</div>
			)}
			{props.response && (
				<div className='space-y-2'>
					<h4 className='font-medium'>{t(prefix + 'responseJson')}</h4>
					{props.response.redactedPaths.length > 0 && (
						<p role='status' className='text-muted-foreground text-xs'>
							{t(prefix + 'redactedResponse', {
								count: props.response.redactedPaths.length,
							})}
						</p>
					)}
					<pre className='bg-muted max-h-80 overflow-auto rounded-md p-3 text-xs break-all whitespace-pre-wrap'>
						{JSON.stringify(props.response.body, null, 2)}
					</pre>
				</div>
			)}
		</section>
	)
}
