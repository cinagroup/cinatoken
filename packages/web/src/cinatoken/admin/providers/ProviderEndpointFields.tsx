import { useState } from 'react'
import type { Path, UseFormRegister } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import { Label } from '../../../components/ui/label'
import {
	PROVIDER_CAPABILITIES,
	PROVIDER_PROTOCOLS,
	type ProviderProtocol,
} from '../provider-endpoints'
import type { ProviderFormValues } from './provider-form'

const prefix = 'cinatoken.adminProviders.'
const names = {
	openai: 'OpenAI',
	anthropic: 'Anthropic',
	gemini: 'Gemini',
	dashscope: 'DashScope',
}
export function ProviderEndpointFields(props: {
	register: UseFormRegister<ProviderFormValues>
	disabled: boolean
}) {
	const { t } = useTranslation()
	const [protocol, setProtocol] = useState<ProviderProtocol>('openai')
	const field = (name: string) =>
		props.register(
			('endpoints.' + protocol + '.' + name) as Path<ProviderFormValues>
		)
	return (
		<section className='space-y-4'>
			<div
				className='flex flex-wrap gap-2'
				role='group'
				aria-label={t(prefix + 'endpoints')}
			>
				{PROVIDER_PROTOCOLS.map((value) => (
					<Button
						key={value}
						type='button'
						variant={protocol === value ? 'secondary' : 'outline'}
						aria-pressed={protocol === value}
						onClick={() => setProtocol(value)}
					>
						{names[value]}
					</Button>
				))}
			</div>
			<Label htmlFor={'provider-base-' + protocol}>
				{t(prefix + 'baseUrl', { protocol: names[protocol] })}
			</Label>
			<Input
				key={protocol}
				id={'provider-base-' + protocol}
				{...field('base')}
				disabled={props.disabled}
				autoComplete='off'
			/>
			{protocol === 'gemini' && (
				<div className='space-y-2'>
					<Label htmlFor='provider-gemini-auth'>{t(prefix + 'auth')}</Label>
					<select
						id='provider-gemini-auth'
						className='bg-background h-10 w-full rounded-md border px-3'
						{...field('auth')}
						disabled={props.disabled}
					>
						<option value='auto'>{t(prefix + 'autoAuth')}</option>
						<option value='query-key'>{t(prefix + 'queryKey')}</option>
						<option value='bearer'>{t(prefix + 'bearer')}</option>
					</select>
				</div>
			)}
			<p className='text-muted-foreground text-xs'>
				{t(prefix + 'endpointHint')}
			</p>
			<details>
				<summary className='cursor-pointer text-sm'>
					{t(prefix + 'overrides')}
				</summary>
				<div className='mt-4 grid gap-4 sm:grid-cols-2'>
					{PROVIDER_CAPABILITIES[protocol].map((capability) => (
						<div key={protocol + capability} className='min-w-0 space-y-2'>
							<Label htmlFor={'provider-override-' + capability}>
								{t(prefix + 'override', { capability })}
							</Label>
							<Input
								id={'provider-override-' + capability}
								{...field('endpoints.' + capability.replaceAll('.', '_'))}
								disabled={props.disabled}
								autoComplete='off'
							/>
						</div>
					))}
				</div>
			</details>
		</section>
	)
}
