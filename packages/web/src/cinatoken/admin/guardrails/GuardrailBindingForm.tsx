/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useId, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import { Label } from '../../../components/ui/label'
import {
	adminGuardrailScopeSchema,
	type AdminGuardrailScopeType,
} from './guardrails-contracts'
import type { AdminGuardrailBindingDraft } from './use-admin-guardrails-manager'

const prefix = 'cinatoken.adminGuardrails.'

export function GuardrailBindingForm(props: {
	draft?: AdminGuardrailBindingDraft
	disabled: boolean
	onReview: (draft: AdminGuardrailBindingDraft) => void
}) {
	const { t } = useTranslation()
	const id = useId()
	const [scopeType, setScopeType] = useState<AdminGuardrailScopeType>(
		props.draft?.scopeType ?? 'user'
	)
	const [scopeId, setScopeId] = useState(props.draft?.scopeId ?? '')
	const [invalid, setInvalid] = useState(false)
	function review(event: FormEvent<HTMLFormElement>): void {
		event.preventDefault()
		if (props.disabled) return
		const result = adminGuardrailScopeSchema.safeParse({
			scopeType,
			scopeId: scopeId.trim(),
		})
		if (!result.success) return setInvalid(true)
		setInvalid(false)
		props.onReview(result.data)
	}
	return (
		<form className='space-y-2 rounded-lg border p-3' onSubmit={review}>
			<div className='grid gap-2 sm:grid-cols-[9rem_minmax(0,1fr)_auto] sm:items-end'>
				<div className='space-y-1'>
					<Label htmlFor={id + '-type'}>{t(prefix + 'scopeType')}</Label>
					<select
						id={id + '-type'}
						className='bg-background h-10 w-full min-w-0 rounded-md border px-3 text-sm'
						value={scopeType}
						disabled={props.disabled}
						onChange={(event) => {
							setScopeType(event.target.value as AdminGuardrailScopeType)
							setInvalid(false)
						}}
					>
						<option value='user'>{t(prefix + 'scopeUser')}</option>
						<option value='api_key'>{t(prefix + 'scopeKey')}</option>
					</select>
				</div>
				<div className='space-y-1'>
					<Label htmlFor={id + '-scope'}>{t(prefix + 'scopeId')}</Label>
					<Input
						id={id + '-scope'}
						value={scopeId}
						disabled={props.disabled}
						maxLength={600}
						autoComplete='off'
						aria-invalid={invalid}
						aria-describedby={invalid ? id + '-error' : undefined}
						onChange={(event) => {
							setScopeId(event.target.value)
							setInvalid(false)
						}}
					/>
				</div>
				<Button type='submit' disabled={props.disabled || !scopeId.trim()}>
					{t(prefix + 'bind')}
				</Button>
			</div>
			{invalid && (
				<p id={id + '-error'} role='alert' className='text-destructive text-sm'>
					{t(prefix + 'invalidScope')}
				</p>
			)}
		</form>
	)
}
