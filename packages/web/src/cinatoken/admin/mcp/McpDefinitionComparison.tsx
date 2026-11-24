/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { McpDefinitionText } from './McpDefinitionText'
import { McpJson, mcpPrefix } from './McpFields'

export function McpDefinitionComparison(props: {
	current: unknown
	pending: unknown | null
	sideBySide?: boolean
}) {
	const { t } = useTranslation()
	return (
		<section
			aria-label={t(mcpPrefix + 'reviewComparison')}
			className='flex min-w-0 flex-col gap-4'
		>
			{props.pending !== null && (
				<p className='text-muted-foreground text-sm'>
					{t(mcpPrefix + 'reviewTextHint')}
				</p>
			)}
			<div
				className={
					props.sideBySide
						? 'grid min-w-0 gap-4 sm:grid-cols-2'
						: 'grid min-w-0 gap-4'
				}
			>
				<div className='flex min-w-0 flex-col gap-3'>
					<McpDefinitionText definition={props.current} label='currentText' />
					<McpJson value={props.current} label='definition' />
				</div>
				{props.pending !== null && (
					<div className='flex min-w-0 flex-col gap-3'>
						<McpDefinitionText definition={props.pending} label='pendingText' />
						<McpJson value={props.pending} label='pendingDefinition' />
					</div>
				)}
			</div>
		</section>
	)
}
