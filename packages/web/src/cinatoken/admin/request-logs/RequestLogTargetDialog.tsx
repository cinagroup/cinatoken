/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from '@/components/ui/dialog'
import { CinaTokenApiError } from '../../api'
import { RequestLogDetail } from './RequestLogDetail'
import type { AdminRequestLogsApi } from './request-log-api'

const prefix = 'cinatoken.adminRequestLogs.'
/** A URL target is read independently, never inferred from the current list page. */
export function RequestLogTargetDialog(props: {
	api: AdminRequestLogsApi
	scopeKey: string
	reconciliationKey: string
	requestId: string
	onClose: () => void
	onAccessLost: () => void
}) {
	const { t } = useTranslation()
	const query = useQuery({
		queryKey: [
			'cinatoken',
			'admin',
			props.scopeKey,
			props.reconciliationKey,
			'request-log-detail',
			props.requestId,
		],
		queryFn: ({ signal }) =>
			props.api.requestLogById(props.requestId, { signal }),
		retry: false,
		refetchOnWindowFocus: false,
		gcTime: 0,
	})
	const failure = query.error
	const onAccessLost = props.onAccessLost
	useEffect(() => {
		if (
			failure instanceof CinaTokenApiError &&
			(failure.status === 401 || failure.status === 403)
		)
			onAccessLost()
	}, [failure, onAccessLost])
	let error = 'readFailed'
	if (failure instanceof CinaTokenApiError) {
		if (failure.status === 401 || failure.status === 403) error = 'accessDenied'
		else if (failure.status === 404) error = 'targetMissing'
		else if (failure.code === 'invalid-response') error = 'invalidResponse'
	}
	const log = query.data
	let content = <p role='status'>{t(prefix + 'loading')}</p>
	if (failure) content = <p role='alert'>{t(prefix + error)}</p>
	else if (log)
		content = (
			<div className='space-y-3'>
				<p className='text-muted-foreground text-xs break-all'>
					{log.status} · <time dateTime={log.created_at}>{log.created_at}</time>{' '}
					· {log.input_tokens} / {log.output_tokens}{' '}
					{t(prefix + 'usage.tokens')}
				</p>
				<RequestLogDetail log={log} />
			</div>
		)
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) props.onClose()
			}}
		>
			<DialogContent
				className='max-h-[85dvh] overflow-y-auto sm:max-w-4xl'
				showCloseButton={false}
			>
				<DialogTitle>{t(prefix + 'targetTitle')}</DialogTitle>
				<DialogDescription>{t(prefix + 'targetHint')}</DialogDescription>
				{content}
				<div className='flex justify-end'>
					<Button type='button' variant='outline' onClick={props.onClose}>
						{t(prefix + 'closeTarget')}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	)
}
