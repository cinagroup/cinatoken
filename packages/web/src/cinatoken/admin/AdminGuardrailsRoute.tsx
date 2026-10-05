/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { cinatokenAdminApi } from './api'
import { useCinaTokenConsole } from './console-context'
import { AdminGuardrails } from './guardrails/AdminGuardrails'
import { createAdminGuardrailPreviewApi } from './guardrails/preview-api'

const previewApi = createAdminGuardrailPreviewApi()

export function AdminGuardrailsRoute() {
	const console = useCinaTokenConsole()
	if (!console.isVerified || !console.scopeKey || !console.identity) return null
	return (
		<AdminGuardrails
			key={console.scopeKey}
			api={cinatokenAdminApi}
			previewApi={previewApi}
			scopeKey={console.scopeKey}
			reconciliationKey={JSON.stringify([
				console.identity.userId,
				console.identity.subject,
				console.identity.epoch,
			])}
			canWrite={console.canWrite}
			subject={console.identity.subject}
			userId={console.identity.userId}
			revalidate={console.revalidate}
		/>
	)
}
