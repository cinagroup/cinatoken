/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import { cn } from '../../../lib/utils'
import { mcpPrefix } from './McpFields'
import {
	MCP_DEFINITION_TEXT_LIMIT,
	mcpDefinitionText,
	type McpDefinitionTextField,
} from './mcp-definition-text'

export function McpDefinitionText(props: {
	definition: unknown
	label: string
}) {
	const { t } = useTranslation()
	const headingId = useId()
	const fields = useMemo(
		() => mcpDefinitionText(props.definition),
		[props.definition]
	)
	const [expansion, setExpansion] = useState({
		definition: props.definition,
		label: props.label,
		title: false,
		description: false,
	})
	const current =
		Object.is(expansion.definition, props.definition) &&
		expansion.label === props.label
	// Reset view ownership, without treating reference identity as definition equality.
	if (!current)
		setExpansion({
			definition: props.definition,
			label: props.label,
			title: false,
			description: false,
		})
	return (
		<section
			aria-labelledby={headingId}
			className='flex min-w-0 flex-col gap-3'
		>
			<h4 id={headingId} className='text-sm font-medium break-words'>
				{t(mcpPrefix + props.label)}
			</h4>
			<dl className='flex min-w-0 flex-col gap-3 text-sm'>
				<DefinitionTextField
					value={fields.title}
					label='definitionTitle'
					expanded={current && expansion.title}
					onToggle={() =>
						setExpansion((previous) => ({
							...previous,
							title: !previous.title,
						}))
					}
				/>
				<DefinitionTextField
					value={fields.description}
					label='definitionDescription'
					expanded={current && expansion.description}
					onToggle={() =>
						setExpansion((previous) => ({
							...previous,
							description: !previous.description,
						}))
					}
				/>
			</dl>
		</section>
	)
}

const fallbackKeys = {
	missing: 'definitionTextMissing',
	empty: 'definitionTextEmpty',
	invalid: 'definitionTextInvalid',
} as const

function DefinitionTextField(props: {
	value: McpDefinitionTextField
	label: 'definitionTitle' | 'definitionDescription'
	expanded: boolean
	onToggle: () => void
}) {
	const { t, i18n } = useTranslation()
	const textId = useId()
	const field = t(mcpPrefix + props.label)
	if (props.value.status !== 'text')
		return (
			<div className='min-w-0'>
				<dt className='font-medium'>{field}</dt>
				<dd className='text-muted-foreground mt-1 break-words'>
					{t(mcpPrefix + fallbackKeys[props.value.status])}
				</dd>
			</div>
		)
	let text = props.value.text
	if (props.value.expandable && !props.expanded)
		text = props.value.preview + '…'
	const limit = new Intl.NumberFormat(
		i18n.resolvedLanguage ?? i18n.language
	).format(MCP_DEFINITION_TEXT_LIMIT)
	return (
		<div className='min-w-0'>
			<dt className='font-medium'>{field}</dt>
			<dd className='mt-1 flex min-w-0 flex-col items-start gap-2'>
				<p
					id={textId}
					className={cn(
						'text-muted-foreground w-full min-w-0 [overflow-wrap:anywhere] break-words whitespace-pre-wrap',
						props.value.expandable && !props.expanded && 'line-clamp-2'
					)}
				>
					{text}
				</p>
				{props.value.truncated && (
					<p className='text-muted-foreground text-xs break-words'>
						{t(mcpPrefix + 'definitionTextTruncated', { limit })}
					</p>
				)}
				{props.value.expandable && (
					<Button
						type='button'
						variant='ghost'
						size='sm'
						className='h-auto max-w-full text-left whitespace-normal'
						aria-expanded={props.expanded}
						aria-controls={textId}
						onClick={props.onToggle}
					>
						{t(
							mcpPrefix +
								(props.expanded ? 'definitionTextLess' : 'definitionTextMore'),
							{ field }
						)}
					</Button>
				)}
			</dd>
		</div>
	)
}
