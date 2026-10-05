/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { UserDetailBudgetTransition } from './UserDetailBudgetTransition'
import { UserDetailFactors } from './UserDetailFactors'
import { UserDetailKeys } from './UserDetailKeys'
import { UserDetailProfile } from './UserDetailProfile'
import { UserDetailRecent } from './UserDetailRecent'
import type { useAdminUserDetail } from './use-user-detail'
import type { AdminUserDetailApi } from './user-detail-api'
import type { UserDetail } from './user-detail-contracts'

const prefix = 'cinatoken.adminUserDetail.'
export function UserDetailSections(props: {
	manager: ReturnType<typeof useAdminUserDetail>
	user: UserDetail
	api: AdminUserDetailApi
}) {
	const { t } = useTranslation()
	const manager = props.manager
	const user = props.user
	const keys =
		manager.blocked.keys ||
		manager.keysQuery.error ||
		manager.keysQuery.isFetching
			? null
			: (manager.keysQuery.data ?? null)
	const logs =
		manager.blocked.logs ||
		manager.logsQuery.error ||
		manager.logsQuery.isFetching
			? null
			: (manager.logsQuery.data ?? null)
	const audits =
		manager.blocked.audits ||
		manager.auditsQuery.error ||
		manager.auditsQuery.isFetching
			? null
			: (manager.auditsQuery.data ?? null)
	const models =
		manager.blocked.models ||
		manager.modelsQuery.error ||
		manager.modelsQuery.isFetching
			? null
			: (manager.modelsQuery.data ?? null)

	return (
		<>
			{!manager.currency && (
				<p role='status' className='rounded-xl border p-3 text-sm'>
					{t(prefix + 'currencyUnavailable')}
				</p>
			)}
			{!manager.timezone && (
				<p role='status' className='rounded-xl border p-3 text-sm'>
					{t(prefix + 'utcFallback')}
				</p>
			)}
			<UserDetailProfile
				key={JSON.stringify([
					user.id,
					user.updated_at,
					user.budget_spent,
					user.budget_max,
				])}
				user={user}
				currency={manager.currency}
				canWrite={manager.canWriteUser}
				busy={manager.busy}
				onSave={manager.saveDraft}
				onDelete={manager.hardDeleteUser}
			/>
			<UserDetailKeys
				key={JSON.stringify([
					user.id,
					manager.keyAccessValid,
					manager.blocked.keys,
					Boolean(manager.keysQuery.error),
				])}
				api={props.api}
				keys={keys}
				denied={manager.blocked.keys}
				failed={Boolean(manager.keysQuery.error)}
				canWrite={manager.canWriteKeys}
				accessValid={manager.keyAccessValid}
				unknown={manager.unknownWrite}
				busy={manager.busy}
				createUnknown={manager.keyCreateUnknown}
				createSafetyUnavailable={manager.keyCreateSafetyUnavailable}
				timezone={manager.timezone}
				onCreate={manager.addKey}
				onStatus={manager.setKeyStatus}
				onDelete={manager.hardDeleteKey}
				onReadDenied={manager.keyReadDenied}
				onSave={manager.keyWriter.save}
			/>
			<UserDetailBudgetTransition
				key={JSON.stringify([
					user.id,
					user.budget_max,
					user.budget_base,
					user.budget_spent,
					user.budget_period,
					user.budget_reset_at,
				])}
				user={user}
				currency={manager.currency}
				timezone={manager.timezone}
				canWrite={manager.canWriteUser}
				busy={manager.busy}
				preview={manager.transitionPreview}
				error={manager.transitionError}
				unknown={manager.transitionUnknown}
				safetyUnavailable={manager.transitionSafetyUnavailable}
				onPreview={manager.previewBudgetTransition}
				onApply={manager.applyBudgetTransition}
				onInvalidate={manager.invalidateBudgetTransition}
			/>
			<UserDetailFactors
				key={JSON.stringify([
					user.id,
					user.updated_at,
					user.charged_cost_factors,
				])}
				user={user}
				models={models}
				modelsDenied={manager.blocked.models}
				canWrite={manager.canWriteUser}
				busy={manager.busy}
				onSave={manager.saveFactors}
			/>
			<UserDetailRecent
				userId={user.id}
				logs={logs}
				audits={audits}
				logsDenied={manager.blocked.logs}
				auditsDenied={manager.blocked.audits}
				logsFailed={Boolean(manager.logsQuery.error)}
				auditsFailed={Boolean(manager.auditsQuery.error)}
				currency={manager.currency}
				timezone={manager.timezone}
			/>
		</>
	)
}
