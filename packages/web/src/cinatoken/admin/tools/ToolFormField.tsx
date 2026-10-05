/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useId } from 'react'
import type { UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Input } from '../../../components/ui/input'
import { toolsPrefix } from './tools-domain'
import type { ToolEditorForm } from './tools-editor-form'

export function ToolFormField(props: {
	form: UseFormReturn<ToolEditorForm>
	name: keyof ToolEditorForm
	label: string
	disabled?: boolean
	secret?: boolean
	onSecretInput?: () => void
}) {
	const { t } = useTranslation(),
		id = useId(),
		invalid = Boolean(props.form.formState.errors[props.name])
	return (
		<div className='min-w-0 space-y-1'>
			<label htmlFor={id} className='text-sm'>
				{t(props.label)}
			</label>
			<Input
				id={id}
				type={props.secret ? 'password' : 'text'}
				autoComplete='off'
				spellCheck={false}
				disabled={props.disabled}
				aria-invalid={invalid}
				aria-describedby={invalid ? id + '-error' : undefined}
				{...props.form.register(props.name, { onChange: props.onSecretInput })}
			/>
			{invalid && (
				<p id={id + '-error'} role='alert' className='text-destructive text-xs'>
					{t(toolsPrefix + 'invalidInput')}
				</p>
			)}
		</div>
	)
}
