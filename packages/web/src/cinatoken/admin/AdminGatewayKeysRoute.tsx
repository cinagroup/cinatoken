/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { getRouteApi } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { cinatokenAdminApi } from './api'
import { useCinaTokenConsole } from './console-context'
import { AdminGatewayKeys } from './gateway-keys/AdminGatewayKeys'
import { createAdminGuardrailPreviewApi } from './guardrails/preview-api'

const route = getRouteApi('/admin/keys')
const previewApi = createAdminGuardrailPreviewApi()
export function AdminGatewayKeysRoute() {
	const { t } = useTranslation()
	const console = useCinaTokenConsole()
	const search = route.useSearch()
	const navigate = route.useNavigate()
	if (!console.isVerified || !console.scopeKey || !console.identity) return null
	if (search.invalidFilter)
		return (
			<main className='space-y-4'>
				<h1 className='text-2xl font-semibold'>
					{t('cinatoken.adminGatewayKeys.title')}
				</h1>
				<p role='alert' className='rounded-xl border p-5'>
					{t('cinatoken.adminGatewayKeys.invalidInput')}
				</p>
				<a className='text-primary underline' href='/admin/keys'>
					{t('cinatoken.adminGatewayKeys.clearFilters')}
				</a>
			</main>
		)
	return (
		<AdminGatewayKeys
			api={cinatokenAdminApi}
			previewApi={previewApi}
			scopeKey={console.scopeKey}
			reconciliationKey={JSON.stringify([
				console.identity.userId,
				console.identity.subject,
				console.identity.epoch,
			])}
			canWrite={console.canWrite}
			revalidate={console.revalidate}
			search={search}
			onSearchChange={(next) => void navigate({ search: next, replace: true })}
		/>
	)
}
