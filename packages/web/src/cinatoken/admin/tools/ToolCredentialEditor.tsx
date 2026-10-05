/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useId } from 'react'
import type { UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import { ToolFormField } from './ToolFormField'
import { toolsPrefix } from './tools-domain'
import type { ToolEditorForm } from './tools-editor-form'

type Name = 'apiKey' | 'secretId' | 'secretKey' | 'region' | 'bizType'
export function ToolCredentialEditor(props: {
	form: UseFormReturn<ToolEditorForm>
	name: Name
	configured: boolean
	setting?: string | null
	disabled: boolean
	canReveal?: boolean
	onReveal?: () => void
	onSecretInput?: () => void
}) {
	const { t } = useTranslation(),
		id = useId(),
		operation = props.form.watch(`${props.name}Op`),
		secret = props.name !== 'region' && props.name !== 'bizType'
	return (
		<fieldset className='min-w-0 space-y-2 rounded-lg border p-3'>
			<legend className='px-1 text-sm'>
				{t(toolsPrefix + props.name)} ·{' '}
				{t(toolsPrefix + (props.configured ? 'configured' : 'missing'))}
			</legend>
			{!secret && (
				<p className='text-xs break-all'>
					{props.setting ?? t(toolsPrefix + 'unavailableSetting')}
				</p>
			)}
			<label htmlFor={id} className='text-sm'>
				{t(toolsPrefix + 'operation')}
			</label>
			<select
				id={id}
				disabled={props.disabled}
				className='bg-background w-full rounded-md border p-2 text-sm'
				{...props.form.register(`${props.name}Op`, {
					onChange: () => props.form.setValue(props.name, ''),
				})}
			>
				<option value='keep'>{t(toolsPrefix + 'keep')}</option>
				<option value='set'>{t(toolsPrefix + 'set')}</option>
				<option value='clear'>{t(toolsPrefix + 'clear')}</option>
			</select>
			{operation === 'set' && (
				<ToolFormField
					form={props.form}
					name={props.name}
					label={toolsPrefix + props.name}
					secret={secret}
					disabled={props.disabled}
					onSecretInput={secret ? props.onSecretInput : undefined}
				/>
			)}
			{secret && (
				<p className='text-muted-foreground text-xs'>
					{t(toolsPrefix + 'setHelp')}
				</p>
			)}
			{secret && props.canReveal && (
				<Button
					type='button'
					size='sm'
					variant='outline'
					disabled={!props.configured}
					onClick={props.onReveal}
				>
					{t(toolsPrefix + 'reveal')}
				</Button>
			)}
		</fieldset>
	)
}
