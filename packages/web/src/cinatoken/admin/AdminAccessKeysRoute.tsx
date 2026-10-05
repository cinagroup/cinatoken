/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { AdminAccessKeys } from './access-keys/AdminAccessKeys'
import { cinatokenAdminApi } from './api'
import { useCinaTokenConsole } from './console-context'

export function AdminAccessKeysRoute() {
	const console = useCinaTokenConsole()
	if (!console.isVerified || !console.scopeKey || !console.identity) return null
	const reconciliationKey = JSON.stringify([
		console.identity.userId,
		console.identity.subject,
		console.identity.epoch,
	])
	return (
		<AdminAccessKeys
			key={JSON.stringify([console.scopeKey, reconciliationKey])}
			api={cinatokenAdminApi}
			scopeKey={console.scopeKey}
			reconciliationKey={reconciliationKey}
			canWrite={console.canWrite}
			revalidate={console.revalidate}
		/>
	)
}
