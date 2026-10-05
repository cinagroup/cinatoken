/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '../../../components/ui/dialog'
import { Input } from '../../../components/ui/input'
import type {
	DataPolicyListRow,
	DataPolicyUpsertInput,
} from './data-policy-contracts'
import { dataPolicyErrorKey } from './data-policy-errors'
import {
	buildDataPolicyInput,
	draftFromDataPolicy,
	DataPolicyFormError,
} from './data-policy-form'

const prefix = 'cinatoken.adminDataPolicies.'
const selectClass =
	'bg-background h-10 w-full min-w-0 rounded-md border px-3 text-sm'

export function DataPolicyEditorDialog(props: {
	row: DataPolicyListRow
	disabled: boolean
	pending: boolean
	error: unknown
	onSave: (input: DataPolicyUpsertInput) => void
	onClose: () => void
}) {
	const { t } = useTranslation()
	const title = useRef<HTMLHeadingElement>(null)
	const [draft, setDraft] = useState(() => draftFromDataPolicy(props.row))
	const [review, setReview] = useState<DataPolicyUpsertInput | null>(null)
	const [localError, setLocalError] = useState<string | null>(null)

	function submit(event: FormEvent<HTMLFormElement>): void {
		event.preventDefault()
		setLocalError(null)
		try {
			setReview(buildDataPolicyInput(draft))
		} catch (error) {
			if (error instanceof DataPolicyFormError) {
				const key =
					error.code === 'retention' ||
					error.code === 'evidence' ||
					error.code === 'expiry'
						? error.code + 'Error'
						: error.code
				setLocalError(prefix + key)
			} else setLocalError(prefix + 'invalidInput')
		}
	}
	const errorKey = props.error ? dataPolicyErrorKey(props.error) : localError
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) props.onClose()
			}}
		>
			<DialogContent
				initialFocus={title}
				showCloseButton={false}
				className='max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl'
			>
				<DialogHeader>
					<DialogTitle ref={title} tabIndex={-1}>
						{review ? t(prefix + 'confirmTitle') : t(prefix + 'edit')}
					</DialogTitle>
					<DialogDescription className='break-all'>
						{props.row.provider_name} ·{' '}
						{props.row.provider_model_name || props.row.model_id}
						<br />
						{t(prefix + 'model')}: {props.row.model_id}
						<br />
						{props.row.route_target_id}
					</DialogDescription>
				</DialogHeader>
				{review ? (
					<div className='space-y-4 text-sm'>
						<p>{t(prefix + 'confirmText')}</p>
						<dl className='grid grid-cols-2 gap-2 rounded-lg border p-3'>
							<dt className='text-muted-foreground'>
								{t(prefix + 'storedStatus')}
							</dt>
							<dd>{t(prefix + review.status)}</dd>
							<dt className='text-muted-foreground'>
								{t(prefix + 'retention')}
							</dt>
							<dd>{review.retention_days ?? t(prefix + 'notSet')}</dd>
							<dt className='text-muted-foreground'>
								{t(prefix + 'training')}
							</dt>
							<dd>{t(prefix + (review.training_allowed ? 'yes' : 'no'))}</dd>
							<dt className='text-muted-foreground'>{t(prefix + 'zdr')}</dt>
							<dd>{t(prefix + (review.zdr_supported ? 'yes' : 'no'))}</dd>
							<dt className='text-muted-foreground'>{t(prefix + 'expiry')}</dt>
							<dd className='break-all'>
								{review.expires_at
									? new Date(review.expires_at).toLocaleString()
									: t(prefix + 'notSet')}
							</dd>
							<dt className='text-muted-foreground'>
								{t(prefix + 'evidence')}
							</dt>
							<dd className='break-all'>
								{review.evidence_url ?? t(prefix + 'notSet')}
							</dd>
						</dl>
						{review.status === 'verified' ? (
							<p
								role='alert'
								className='rounded-lg border border-amber-500/40 bg-amber-500/10 p-3'
							>
								{t(prefix + 'verifiedWarning')}
							</p>
						) : null}
						{errorKey ? (
							<p role='alert' className='text-destructive'>
								{t(errorKey)}
							</p>
						) : null}
						<DialogFooter className='gap-2 sm:gap-0'>
							<Button
								type='button'
								variant='outline'
								disabled={props.pending}
								onClick={() => setReview(null)}
							>
								{t(prefix + 'cancel')}
							</Button>
							<Button
								type='button'
								disabled={props.disabled || props.pending}
								onClick={() => props.onSave(review)}
							>
								{t(prefix + 'save')}
							</Button>
						</DialogFooter>
					</div>
				) : (
					<form className='space-y-4' onSubmit={submit}>
						<label className='block space-y-1 text-sm'>
							<span>{t(prefix + 'storedStatus')}</span>
							<select
								className={selectClass}
								value={draft.status}
								onChange={(event) =>
									setDraft({
										...draft,
										status: event.target.value as typeof draft.status,
									})
								}
							>
								<option value='unknown'>{t(prefix + 'unknown')}</option>
								<option value='expired'>{t(prefix + 'expired')}</option>
								<option value='verified'>{t(prefix + 'verified')}</option>
							</select>
						</label>
						<label className='block space-y-1 text-sm'>
							<span>{t(prefix + 'retention')}</span>
							<Input
								type='number'
								min={0}
								max={36500}
								step={1}
								value={draft.retentionDays}
								onChange={(event) =>
									setDraft({ ...draft, retentionDays: event.target.value })
								}
							/>
							<span className='text-muted-foreground block text-xs'>
								{t(prefix + 'retentionHint')}
							</span>
						</label>
						<label className='flex min-h-10 items-center gap-3 text-sm'>
							<input
								type='checkbox'
								checked={draft.trainingAllowed}
								onChange={(event) =>
									setDraft({ ...draft, trainingAllowed: event.target.checked })
								}
							/>
							<span>{t(prefix + 'training')}</span>
						</label>
						<label className='flex min-h-10 items-center gap-3 text-sm'>
							<input
								type='checkbox'
								checked={draft.zdrSupported}
								onChange={(event) =>
									setDraft({ ...draft, zdrSupported: event.target.checked })
								}
							/>
							<span>{t(prefix + 'zdr')}</span>
						</label>
						<label className='block space-y-1 text-sm'>
							<span>{t(prefix + 'evidence')}</span>
							<Input
								type='url'
								autoComplete='url'
								value={draft.evidenceUrl}
								onChange={(event) =>
									setDraft({ ...draft, evidenceUrl: event.target.value })
								}
								placeholder='https://example.com/policy'
							/>
							<span className='text-muted-foreground block text-xs'>
								{t(prefix + 'evidenceHint')}
							</span>
						</label>
						<label className='block space-y-1 text-sm'>
							<span>{t(prefix + 'expiry')}</span>
							<Input
								type='datetime-local'
								step={1}
								value={draft.expiresLocal}
								onChange={(event) =>
									setDraft({ ...draft, expiresLocal: event.target.value })
								}
							/>
							<span className='text-muted-foreground block text-xs'>
								{t(prefix + 'expiryHint')}
							</span>
						</label>
						{errorKey ? (
							<p role='alert' className='text-destructive text-sm'>
								{t(errorKey)}
							</p>
						) : null}
						<DialogFooter className='gap-2 sm:gap-0'>
							<Button
								type='button'
								variant='outline'
								disabled={props.pending}
								onClick={props.onClose}
							>
								{t(prefix + 'cancel')}
							</Button>
							<Button type='submit' disabled={props.disabled || props.pending}>
								{t(prefix + 'continue')}
							</Button>
						</DialogFooter>
					</form>
				)}
			</DialogContent>
		</Dialog>
	)
}
