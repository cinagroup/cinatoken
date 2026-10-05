/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { cinatokenAdminApi } from './api'
import { useCinaTokenConsole } from './console-context'
import { AdminRequestLogs } from './request-logs/AdminRequestLogs'
import {
	emptyRequestLogFilters,
	type RequestLogSearch,
} from './request-logs/request-log-domain'

export function AdminRequestLogsRoute() {
	const console = useCinaTokenConsole()
	const { t } = useTranslation()
	const search = useSearch({ from: '/admin/request-logs' })
	const navigate = useNavigate()
	if (!console.isVerified || !console.scopeKey || !console.identity) return null
	const reconciliationKey = JSON.stringify([
		console.identity.userId,
		console.identity.subject,
		console.identity.epoch,
	])
	function onSearch(next: RequestLogSearch): void {
		void navigate({ to: '/admin/request-logs', search: next, replace: true })
	}
	if (search.invalidTarget)
		return (
			<main className='space-y-4 rounded-xl border p-5'>
				<p role='alert'>{t('cinatoken.adminRequestLogs.invalidTarget')}</p>
				<Button
					type='button'
					variant='outline'
					onClick={() => onSearch(emptyRequestLogFilters)}
				>
					{t('cinatoken.adminRequestLogs.clearTarget')}
				</Button>
			</main>
		)
	return (
		<AdminRequestLogs
			key={JSON.stringify([console.scopeKey, reconciliationKey])}
			api={cinatokenAdminApi}
			scopeKey={console.scopeKey}
			reconciliationKey={reconciliationKey}
			revalidate={console.revalidate}
			search={search}
			onSearch={onSearch}
		/>
	)
}
