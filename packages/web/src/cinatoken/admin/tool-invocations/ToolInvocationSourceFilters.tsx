/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
	Field,
	FieldError,
	FieldGroup,
	FieldLabel,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { isMcpServerSlug } from './mcp-invocation-domain'
import {
	changeToolInvocationSource,
	validateToolInvocationSearch,
	type ToolInvocationSearch,
} from './tool-invocation-domain'

const prefix = 'cinatoken.adminToolInvocations.invocations.'

export function ToolInvocationSourceFilters(props: {
	search: ToolInvocationSearch
	onSearch: (search: ToolInvocationSearch) => void
}) {
	const { t } = useTranslation()
	const id = useId()
	const [server, setServer] = useState(props.search.server ?? '')
	const [invalid, setInvalid] = useState(false)
	const source = props.search.source ?? 'rest'
	return (
		<FieldGroup className='bg-card flex-row flex-wrap items-start rounded-xl border p-4'>
			<Field className='w-auto'>
				<FieldLabel id={`${id}-source`}>{t(prefix + 'source')}</FieldLabel>
				<ToggleGroup
					aria-labelledby={`${id}-source`}
					variant='outline'
					value={[source]}
					onValueChange={(values) => {
						const next = values[0]
						if (
							(next === 'rest' || next === 'mcp' || next === 'all') &&
							next !== source
						)
							props.onSearch(changeToolInvocationSource(props.search, next))
					}}
				>
					<ToggleGroupItem value='all'>
						{t(prefix + 'sourceAll')}
					</ToggleGroupItem>
					<ToggleGroupItem value='rest'>
						{t(prefix + 'sourceRest')}
					</ToggleGroupItem>
					<ToggleGroupItem value='mcp'>
						{t(prefix + 'sourceMcp')}
					</ToggleGroupItem>
				</ToggleGroup>
				{source === 'all' && (
					<p className='text-muted-foreground max-w-md text-xs'>
						{t(prefix + 'sourceAllHint')}
					</p>
				)}
			</Field>
			{source === 'mcp' ? (
				<form
					className='flex min-w-0 flex-1 basis-full flex-wrap items-start gap-3 sm:basis-72'
					onSubmit={(event) => {
						event.preventDefault()
						if (server && !isMcpServerSlug(server)) {
							setInvalid(true)
							return
						}
						setInvalid(false)
						props.onSearch(
							validateToolInvocationSearch({
								...props.search,
								server,
								invalidFilter: undefined,
								page: 1,
							})
						)
					}}
				>
					<Field
						className='min-w-48 flex-1'
						data-invalid={invalid || undefined}
					>
						<FieldLabel htmlFor={`${id}-server`}>
							{t(prefix + 'serverFilter')}
						</FieldLabel>
						<Input
							id={`${id}-server`}
							value={server}
							maxLength={40}
							placeholder={t(prefix + 'allServers')}
							aria-invalid={invalid || undefined}
							aria-describedby={`${id}-server-hint`}
							onChange={(event) => {
								setServer(event.target.value)
								setInvalid(false)
							}}
						/>
						{invalid ? (
							<FieldError>{t(prefix + 'invalidServer')}</FieldError>
						) : null}
						<p
							id={`${id}-server-hint`}
							className='text-muted-foreground text-xs'
						>
							{t(prefix + 'serverHint')}
						</p>
					</Field>
					<Button type='submit' variant='outline' className='mt-6'>
						{t(prefix + 'applyServer')}
					</Button>
				</form>
			) : null}
		</FieldGroup>
	)
}
