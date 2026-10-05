/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { CinaTokenApiError } from '../../api'
import { RequestLogTable } from './RequestLogTable'
import type { useRequestLogs } from './use-request-logs'

const prefix = 'cinatoken.adminRequestLogs.'
function errorKey(error: unknown): string {
	if (error instanceof CinaTokenApiError) {
		if (error.status === 401 || error.status === 403) return 'accessDenied'
		if (error.code === 'invalid-response') return 'invalidResponse'
	}
	return 'readFailed'
}
export function RequestLogsContent(props: {
	state: ReturnType<typeof useRequestLogs>
	expanded: string | null
	onExpand: (id: string) => void
}) {
	const { t, i18n } = useTranslation()
	if (props.state.logsBlocked || props.state.error)
		return (
			<section
				role='alert'
				className='border-destructive/40 bg-destructive/5 rounded-xl border p-5'
			>
				<p>
					{t(
						prefix +
							(props.state.logsBlocked
								? 'accessDenied'
								: errorKey(props.state.error))
					)}
				</p>
				<Button
					type='button'
					variant='outline'
					className='mt-3'
					onClick={props.state.retry}
				>
					{t(prefix + 'retry')}
				</Button>
			</section>
		)
	if (props.state.page)
		return (
			<RequestLogTable
				page={props.state.page}
				models={props.state.models}
				providers={props.state.providers}
				currency={props.state.currency}
				timezone={props.state.timezone}
				locale={i18n.resolvedLanguage || 'en'}
				expanded={props.expanded}
				onExpand={props.onExpand}
			/>
		)
	return (
		<p
			role='status'
			className='text-muted-foreground rounded-xl border p-8 text-center'
		>
			{t(prefix + 'loading')}
		</p>
	)
}
