/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useId, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type { GatewayKeyDetail } from '../gateway-keys/gateway-key-contracts'
import {
	gatewayKeyEditFormSchema,
	gatewayKeyEditInput,
	type GatewayKeyEditForm,
	type GatewayKeyPatch,
} from '../gateway-keys/gateway-key-input'
import { safeLogJson } from '../request-logs/request-log-domain'

const prefix = 'cinatoken.adminGatewayKeys.'
const inputClass = 'bg-background w-full rounded-md border px-3 py-2 text-sm'
export function UserDetailKeyEditor(props: {
	detail: GatewayKeyDetail
	canWrite: boolean
	busy: boolean
	onClose: () => void
	onSave: (
		patch: GatewayKeyPatch
	) => Promise<'saved' | 'rejected' | 'unknown' | 'conflict'>
}) {
	const { t } = useTranslation()
	const formId = useId()
	const [failed, setFailed] = useState(false)
	const form = useForm<GatewayKeyEditForm>({
		resolver: zodResolver(gatewayKeyEditFormSchema),
		defaultValues: {
			name: props.detail.name ?? '',
			status: props.detail.status,
			statusConfirmed: false,
			metadataMode: 'unchanged',
			metadata: '',
			reason: '',
		},
	})
	const metadataMode = form.watch('metadataMode')
	const status = form.watch('status')
	const statusConfirmed = form.watch('statusConfirmed')
	async function submit(draft: GatewayKeyEditForm): Promise<void> {
		let patch: GatewayKeyPatch
		try {
			patch = gatewayKeyEditInput(props.detail, draft)
		} catch {
			form.setError('metadata', { message: 'metadataInvalid' })
			return
		}
		const outcome = await props.onSave(patch)
		if (outcome === 'rejected') setFailed(true)
		else props.onClose()
	}
	return (
		<form className='space-y-4' onSubmit={form.handleSubmit(submit)}>
			<dl className='grid gap-2 text-xs break-all'>
				<div>
					<dt>{t(prefix + 'keyId')}</dt>
					<dd className='font-mono'>{props.detail.id}</dd>
				</div>
				<div>
					<dt>{t(prefix + 'userId')}</dt>
					<dd className='font-mono'>{props.detail.user_id}</dd>
				</div>
				<div>
					<dt>{t(prefix + 'workspace')}</dt>
					<dd className='font-mono'>{props.detail.workspace_id}</dd>
				</div>
			</dl>
			{failed && (
				<p role='alert' className='text-destructive text-sm'>
					{t(prefix + 'writeFailed')}
				</p>
			)}
			<div className='space-y-1 text-sm'>
				<label className='block' htmlFor={formId + '-name'}>
					{t(prefix + 'name')}
				</label>
				<input
					id={formId + '-name'}
					className={inputClass}
					maxLength={255}
					disabled={props.busy || !props.canWrite}
					aria-invalid={Boolean(form.formState.errors.name)}
					aria-describedby={
						form.formState.errors.name ? formId + '-name-error' : undefined
					}
					{...form.register('name')}
				/>
				{form.formState.errors.name && (
					<span
						id={formId + '-name-error'}
						role='alert'
						className='text-destructive'
					>
						{t(prefix + 'invalidInput')}
					</span>
				)}
			</div>
			<label className='block space-y-1 text-sm'>
				<span>{t(prefix + 'status')}</span>
				<select
					className={inputClass}
					disabled={props.busy || !props.canWrite}
					{...form.register('status')}
				>
					{(['active', 'disabled', 'revoked'] as const).map((value) => (
						<option key={value} value={value}>
							{t(prefix + value)}
						</option>
					))}
				</select>
			</label>
			{status !== props.detail.status && (
				<label className='flex items-center gap-2 text-sm'>
					<input
						type='checkbox'
						disabled={props.busy || !props.canWrite}
						{...form.register('statusConfirmed')}
					/>
					{t(prefix + 'statusConfirm')}
				</label>
			)}
			<label className='block space-y-1 text-sm'>
				<span>{t(prefix + 'metadataUpdate')}</span>
				<select
					className={inputClass}
					disabled={props.busy || !props.canWrite}
					{...form.register('metadataMode')}
				>
					{(['unchanged', 'merge', 'replace'] as const).map((mode) => (
						<option
							key={mode}
							value={mode}
							disabled={
								props.detail.metadata_unavailable && mode !== 'unchanged'
							}
						>
							{t(prefix + mode)}
						</option>
					))}
				</select>
			</label>
			<p className='text-muted-foreground text-xs'>
				{t(prefix + 'metadataHint')}
			</p>
			{props.detail.metadata_unavailable ? (
				<p role='status' className='text-sm text-amber-700 dark:text-amber-300'>
					{t(prefix + 'metadataUnavailable')}
				</p>
			) : (
				<details>
					<summary className='cursor-pointer text-sm'>
						{t(prefix + 'metadataCurrent')}
					</summary>
					<pre className='bg-muted mt-2 max-h-48 overflow-auto rounded-md p-3 text-xs break-all whitespace-pre-wrap'>
						{safeLogJson(props.detail.metadata_raw) ?? '—'}
					</pre>
				</details>
			)}
			{metadataMode !== 'unchanged' && (
				<div className='space-y-1 text-sm'>
					<label className='block' htmlFor={formId + '-metadata'}>
						{t(prefix + 'metadataJson')}
					</label>
					<textarea
						id={formId + '-metadata'}
						className={inputClass + ' font-mono text-xs'}
						rows={5}
						maxLength={65_536}
						disabled={
							props.busy || !props.canWrite || props.detail.metadata_unavailable
						}
						aria-invalid={Boolean(form.formState.errors.metadata)}
						aria-describedby={
							form.formState.errors.metadata
								? formId + '-metadata-error'
								: undefined
						}
						{...form.register('metadata')}
					/>
					{form.formState.errors.metadata && (
						<span
							id={formId + '-metadata-error'}
							role='alert'
							className='text-destructive block text-xs'
						>
							{t(prefix + 'metadataInvalid')}
						</span>
					)}
				</div>
			)}
			{metadataMode === 'replace' && (
				<p className='text-sm text-amber-700 dark:text-amber-300'>
					{t(prefix + 'replaceWarning')}
				</p>
			)}
			<div className='space-y-1 text-sm'>
				<label className='block' htmlFor={formId + '-reason'}>
					{t(prefix + 'reason')}
				</label>
				<input
					id={formId + '-reason'}
					className={inputClass}
					maxLength={600}
					disabled={props.busy || !props.canWrite}
					aria-invalid={Boolean(form.formState.errors.reason)}
					aria-describedby={
						form.formState.errors.reason ? formId + '-reason-error' : undefined
					}
					{...form.register('reason')}
				/>
				{form.formState.errors.reason && (
					<span
						id={formId + '-reason-error'}
						role='alert'
						className='text-destructive block text-xs'
					>
						{t(prefix + 'invalidInput')}
					</span>
				)}
			</div>
			<div className='flex justify-end gap-2 border-t pt-3'>
				<Button
					type='button'
					variant='outline'
					disabled={props.busy}
					onClick={props.onClose}
				>
					{t(prefix + 'cancel')}
				</Button>
				<Button
					type='submit'
					disabled={
						!props.canWrite ||
						props.busy ||
						(status !== props.detail.status && !statusConfirmed)
					}
				>
					{t(prefix + (props.busy ? 'saving' : 'save'))}
				</Button>
			</div>
		</form>
	)
}
