/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { CinaTokenApiError } from '../../api'
import type { AdminAuditLogsApi } from './audit-log-api'
import type { AuditLogSearch } from './audit-log-domain'

const prefix = 'cinatoken.adminAuditLogs.'

function exportErrorKey(error: unknown): string {
	if (error instanceof CinaTokenApiError) {
		if (error.status === 401 || error.status === 403) return 'accessDenied'
		if (error.status === 413) return 'exportTooLarge'
		if (
			error.status === 408 ||
			error.status === 504 ||
			error.code === 'timeout'
		)
			return 'exportTimedOut'
		if (error.code === 'invalid-response') return 'invalidResponse'
	}
	return 'exportFailed'
}

export function AuditLogExportButton(props: {
	api: AdminAuditLogsApi
	search: AuditLogSearch | null
	blocked: boolean
	onDenied: () => void
}) {
	const { t } = useTranslation()
	const [working, setWorking] = useState(false)
	const [message, setMessage] = useState<string | null>(null)
	const controller = useRef<AbortController | null>(null)
	const generation = useRef(0)
	const downloadUrl = useRef<string | null>(null)
	const revokeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
	useEffect(
		() => () => {
			generation.current += 1
			controller.current?.abort()
			if (revokeTimer.current) clearTimeout(revokeTimer.current)
			if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current)
		},
		[]
	)
	function cancel(): void {
		generation.current += 1
		controller.current?.abort()
		controller.current = null
		setWorking(false)
		setMessage('exportCancelled')
	}
	async function download(): Promise<void> {
		if (!props.search || props.blocked || working) return
		const current = ++generation.current
		const request = new AbortController()
		controller.current = request
		setWorking(true)
		setMessage(null)
		try {
			const blob = await props.api.exportAuditLogs(props.search, {
				signal: request.signal,
				timeoutMs: 30_000,
			})
			if (current !== generation.current || request.signal.aborted) return
			if (revokeTimer.current) clearTimeout(revokeTimer.current)
			if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current)
			const url = URL.createObjectURL(blob)
			downloadUrl.current = url
			const link = document.createElement('a')
			link.href = url
			link.download = 'cinatoken-budget-audit-logs.csv'
			link.hidden = true
			document.body.append(link)
			try {
				link.click()
			} finally {
				link.remove()
			}
			revokeTimer.current = setTimeout(() => {
				URL.revokeObjectURL(url)
				if (downloadUrl.current === url) downloadUrl.current = null
				revokeTimer.current = null
			}, 60_000)
		} catch (error) {
			if (current !== generation.current || request.signal.aborted) return
			if (
				error instanceof CinaTokenApiError &&
				(error.status === 401 || error.status === 403)
			)
				props.onDenied()
			setMessage(exportErrorKey(error))
		} finally {
			if (current === generation.current) {
				controller.current = null
				setWorking(false)
			}
		}
	}
	return (
		<div className='flex flex-wrap items-center gap-2'>
			<Button
				type='button'
				variant='outline'
				disabled={!props.search || props.blocked || working}
				onClick={() => void download()}
			>
				{t(prefix + (working ? 'exporting' : 'exportCsv'))}
			</Button>
			{working && (
				<Button type='button' variant='ghost' onClick={cancel}>
					{t(prefix + 'cancelExport')}
				</Button>
			)}
			{message && (
				<span
					role={message === 'exportCancelled' ? 'status' : 'alert'}
					className='text-muted-foreground text-sm'
				>
					{t(prefix + message)}
				</span>
			)}
		</div>
	)
}
