/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useId, useState, type ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { safeMcpJson } from './mcp-domain'

export const mcpPrefix = 'cinatoken.adminMcp.'
export function McpField(props: {
	label: string
	value: string
	onChange: (value: string) => void
	hint?: string
	disabled?: boolean
	required?: boolean
	readOnly?: boolean
	multiline?: boolean
	type?: 'text' | 'password' | 'number' | 'search' | 'url'
	maxLength?: number
	placeholder?: string
}) {
	const { t } = useTranslation()
	const id = useId()
	const shared = {
		id,
		value: props.value,
		disabled: props.disabled,
		required: props.required,
		readOnly: props.readOnly,
		maxLength: props.maxLength,
		placeholder: props.placeholder,
		autoComplete: 'off',
		onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
			props.onChange(event.target.value),
	}
	return (
		<Field data-disabled={props.disabled || undefined}>
			<FieldLabel htmlFor={id}>{t(mcpPrefix + props.label)}</FieldLabel>
			{props.multiline ? (
				<Textarea {...shared} className='min-h-24 font-mono text-xs' />
			) : (
				<Input {...shared} type={props.type ?? 'text'} />
			)}
			{props.hint && (
				<FieldDescription>{t(mcpPrefix + props.hint)}</FieldDescription>
			)}
		</Field>
	)
}
export function McpNotice(props: { message: string; destructive?: boolean }) {
	const { t } = useTranslation()
	return (
		<Alert variant={props.destructive ? 'destructive' : 'default'}>
			<AlertDescription>{t(mcpPrefix + props.message)}</AlertDescription>
		</Alert>
	)
}
export function McpStatus(props: { status: string }) {
	const { t } = useTranslation()
	return (
		<Badge
			variant={
				props.status === 'active' || props.status === 'enabled'
					? 'default'
					: 'secondary'
			}
		>
			{t(mcpPrefix + props.status, { defaultValue: props.status })}
		</Badge>
	)
}
export function McpJson(props: { value: unknown; label: string }) {
	const { t } = useTranslation()
	const [open, setOpen] = useState(false)
	return (
		<details
			onToggle={(event) => setOpen(event.currentTarget.open)}
			className='min-w-0 rounded-lg border p-3'
		>
			<summary className='cursor-pointer text-sm font-medium'>
				{t(mcpPrefix + props.label)}
			</summary>
			{open && (
				<pre className='bg-muted mt-3 max-h-80 overflow-auto rounded-lg p-3 text-xs break-all whitespace-pre-wrap'>
					{safeMcpJson(props.value)}
				</pre>
			)}
		</details>
	)
}
