/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import { toolsPrefix, type ToolCredentialField } from './tools-domain'

export function ToolSecretValue(props: {
	field: ToolCredentialField
	value: string
	onClear: () => void
}) {
	const { t } = useTranslation(),
		[copied, setCopied] = useState(false)
	return (
		<div className='space-y-2 rounded-lg border border-amber-500/50 p-3'>
			<p className='text-xs'>
				{t(toolsPrefix + props.field)} · {t(toolsPrefix + 'revealHelp')}
			</p>
			<code className='block text-sm break-all'>{props.value}</code>
			<div className='flex flex-wrap gap-2'>
				<Button
					type='button'
					size='sm'
					variant='outline'
					onClick={() =>
						void navigator.clipboard
							.writeText(props.value)
							.then(() => setCopied(true))
							.catch(() => setCopied(false))
					}
				>
					{t(toolsPrefix + (copied ? 'copied' : 'copy'))}
				</Button>
				<Button
					type='button'
					size='sm'
					variant='outline'
					onClick={props.onClear}
				>
					{t(toolsPrefix + 'hide')}
				</Button>
			</div>
		</div>
	)
}
