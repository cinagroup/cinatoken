/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useCinaTokenConsole } from './console-context'
import { AdminPolicyWorkbench } from './policy-workbench/AdminPolicyWorkbench'

export function AdminPresetsRoute() {
	const console = useCinaTokenConsole()
	if (!console.isVerified || !console.scopeKey || !console.identity) return null
	return (
		<AdminPolicyWorkbench
			key={console.scopeKey}
			feature='presets'
			session={{
				scopeKey: console.scopeKey,
				subject: console.identity.subject,
				userId: console.identity.userId,
				reconciliationKey: JSON.stringify([
					console.identity.userId,
					console.identity.subject,
					console.identity.epoch,
				]),
				canWrite: console.canWrite,
				revalidate: console.revalidate,
			}}
		/>
	)
}
