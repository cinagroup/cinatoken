/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '../../../components/ui/dialog'
import { Input } from '../../../components/ui/input'
import { Label } from '../../../components/ui/label'
import type { AdminEndpoint, EndpointChoices } from '../endpoint-contracts'
import type { UpdateEndpointInput } from '../endpoint-input'
import { EndpointAudioFields } from './EndpointAudioFields'
import { EndpointIdentityFields } from './EndpointIdentityFields'
import { EndpointImageFields } from './EndpointImageFields'
import { EndpointTextFields } from './EndpointTextFields'
import { endpointErrorKey } from './endpoint-errors'
import {
	endpointFormDefaults,
	endpointFormInput,
	endpointFormSchema,
	type EndpointFormValues,
} from './endpoint-form'

const prefix = 'cinatoken.adminEndpoints.'
const selectClass =
	'bg-background h-10 w-full min-w-0 rounded-md border px-3 text-sm'

export function EndpointEditorDialog(props: {
	row?: AdminEndpoint
	choices: EndpointChoices
	pending: boolean
	disabled: boolean
	error: unknown
	onSave: (input: UpdateEndpointInput, row?: AdminEndpoint) => void
	onClose: () => void
}) {
	const { t } = useTranslation()
	const form = useForm<EndpointFormValues>({
		resolver: zodResolver(endpointFormSchema(props.row)),
		defaultValues: endpointFormDefaults(props.row),
	})
	function submit(values: EndpointFormValues): void {
		try {
			const input = endpointFormInput(values, props.row)
			if (props.row && Object.keys(input).length === 0) {
				form.setError('root', { message: 'unchanged' })
				return
			}
			props.onSave(input, props.row)
		} catch {
			form.setError('root', { message: 'invalid' })
		}
	}
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !props.pending) props.onClose()
			}}
		>
			<DialogContent
				className='max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-5xl'
				showCloseButton={false}
			>
				<DialogHeader>
					<DialogTitle>
						{t(prefix + (props.row ? 'editTitle' : 'createTitle'))}
					</DialogTitle>
					<DialogDescription>{t(prefix + 'editorHint')}</DialogDescription>
				</DialogHeader>
				<form className='space-y-7' onSubmit={form.handleSubmit(submit)}>
					<fieldset
						className='space-y-7 disabled:opacity-60'
						disabled={props.pending || props.disabled}
					>
						<EndpointIdentityFields
							form={form}
							choices={props.choices}
							editing={Boolean(props.row)}
						/>
						<EndpointTextFields form={form} />
						<EndpointImageFields form={form} />
						<EndpointAudioFields form={form} />
						<section className='space-y-4'>
							<h3 className='text-base font-semibold'>
								{t(prefix + 'verification')}
							</h3>
							<p className='text-muted-foreground text-xs'>
								{t(prefix + 'verificationHint')}
							</p>
							<div className='grid gap-4 sm:grid-cols-2'>
								<div className='space-y-2'>
									<Label htmlFor='endpoint-evidence-url'>
										{t(prefix + 'evidenceUrl')}
									</Label>
									<Input
										id='endpoint-evidence-url'
										type='url'
										{...form.register('evidence_url')}
										placeholder='https://provider.example/pricing'
									/>
								</div>
								<div className='space-y-2'>
									<Label htmlFor='endpoint-expires'>
										{t(prefix + 'expiresAt')}
									</Label>
									<Input
										id='endpoint-expires'
										type='datetime-local'
										step='0.001'
										{...form.register('expires_at')}
									/>
								</div>
								<div className='space-y-2'>
									<Label htmlFor='endpoint-status'>
										{t(prefix + 'status')}
									</Label>
									<select
										id='endpoint-status'
										className={selectClass}
										{...form.register('status')}
									>
										{props.row && (
											<option value='keep'>{t(prefix + 'keepStatus')}</option>
										)}
										<option value='draft'>{t(prefix + 'draft')}</option>
										<option value='disabled'>{t(prefix + 'disabled')}</option>
									</select>
								</div>
							</div>
							{props.row?.status === 'verified' && (
								<p className='text-sm text-amber-700 dark:text-amber-300'>
									{t(prefix + 'materialEditWarning')}
								</p>
							)}
						</section>
					</fieldset>
					{(form.formState.errors.root || props.error != null) && (
						<div
							role='alert'
							className='text-destructive space-y-2 rounded-xl border p-3 text-sm'
						>
							{form.formState.errors.root && (
								<p>
									{t(
										prefix +
											(form.formState.errors.root.message === 'unchanged'
												? 'unchanged'
												: 'invalidInput')
									)}
								</p>
							)}
							{props.error != null && (
								<>
									<p>{t(endpointErrorKey(props.error))}</p>
									<p>{t(prefix + 'writeUnknown')}</p>
								</>
							)}
						</div>
					)}
					<div className='flex flex-wrap justify-end gap-2'>
						<Button
							type='button'
							variant='outline'
							onClick={props.onClose}
							disabled={props.pending}
						>
							{t(prefix + 'cancel')}
						</Button>
						<Button
							type='submit'
							disabled={props.pending || props.disabled || props.error != null}
						>
							{t(prefix + (props.pending ? 'saving' : 'save'))}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	)
}
