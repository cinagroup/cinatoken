/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useId } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { AdminGuardrailPreview } from '../guardrails/AdminGuardrailPreview'
import type {
	AdminGuardrailPreviewApi,
	AdminGuardrailPreviewOptions,
} from '../guardrails/preview-api'
import { safeLogJson } from '../request-logs/request-log-domain'
import { GatewayKeyLinks } from './GatewayKeyLinks'
import { GatewayKeyProfile } from './GatewayKeyProfile'
import type {
	GatewayKeyDetail,
	GatewayKeyRow,
	GatewayKeysCapabilities,
} from './gateway-key-contracts'
import {
	gatewayKeyEditFormSchema,
	gatewayKeyEditInput,
	type GatewayKeyPatch,
	type GatewayKeyEditForm,
} from './gateway-key-input'

const prefix = 'cinatoken.adminGatewayKeys.'
const inputClass = 'bg-background w-full rounded-md border px-3 py-2 text-sm'
export function GatewayKeyEditor(props: {
	detail: GatewayKeyDetail
	row: GatewayKeyRow
	capabilities: GatewayKeysCapabilities
	previewApi: AdminGuardrailPreviewApi
	previewReadOptions: (signal?: AbortSignal) => AdminGuardrailPreviewOptions
	scopeKey: string
	currency: 'USD' | 'CNY' | null
	guardrailBlocked: boolean
	onGuardrailDenied: () => void
	busy: boolean
	canWrite: boolean
	error: string | null
	onClose: () => void
	onSave: (patch: GatewayKeyPatch) => Promise<void>
}) {
	const { t } = useTranslation()
	const formId = useId()
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
		try {
			await props.onSave(gatewayKeyEditInput(props.detail, draft))
		} catch {
			form.setError('metadata', { message: 'metadataInvalid' })
		}
	}
	return (
		<div className='space-y-5'>
			<GatewayKeyProfile detail={props.detail} currency={props.currency} />
			<GatewayKeyLinks row={props.row} capabilities={props.capabilities} />
			<form className='space-y-4' onSubmit={form.handleSubmit(submit)}>
				{props.error && (
					<p role='alert' className='text-destructive text-sm'>
						{t(prefix + props.error)}
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
						{(['active', 'disabled', 'revoked'] as const).map((status) => (
							<option key={status} value={status}>
								{t(prefix + status)}
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
					<p
						role='status'
						className='text-sm text-amber-700 dark:text-amber-300'
					>
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
								props.busy ||
								!props.canWrite ||
								props.detail.metadata_unavailable
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
							form.formState.errors.reason
								? formId + '-reason-error'
								: undefined
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
			{props.capabilities.effective_guardrails && !props.guardrailBlocked && (
				<AdminGuardrailPreview
					api={props.previewApi}
					scopeKey={props.scopeKey}
					canRead
					readOptions={props.previewReadOptions}
					onAccessLost={props.onGuardrailDenied}
					onReadFailure={props.onGuardrailDenied}
					initialTarget={{
						workspaceId: props.detail.workspace_id,
						userId: props.detail.user_id,
						apiKeyId: props.detail.id,
					}}
				/>
			)}
		</div>
	)
}
