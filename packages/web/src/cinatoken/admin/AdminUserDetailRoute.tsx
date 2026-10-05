/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { getRouteApi } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { cinatokenAdminApi } from './api'
import { useCinaTokenConsole } from './console-context'
import { AdminUserDetail } from './user-detail/AdminUserDetail'
import { userRouteIdentity } from './user-detail/user-detail-domain'
import { validateUsersSearch } from './users/users-search'

const route = getRouteApi('/admin/users/$userId')

export function AdminUserDetailRoute() {
	const { t } = useTranslation()
	const console = useCinaTokenConsole()
	const params = route.useParams()
	const navigate = route.useNavigate()
	if (!console.isVerified || !console.scopeKey || !console.identity) return null
	if (!userRouteIdentity(params.userId))
		return (
			<main role='alert' className='rounded-xl border p-6'>
				{t('cinatoken.adminUserDetail.invalidRoute')}
			</main>
		)
	return (
		<AdminUserDetail
			key={JSON.stringify([console.scopeKey, params.userId])}
			api={cinatokenAdminApi}
			scopeKey={console.scopeKey}
			reconciliationKey={JSON.stringify([
				console.identity.userId,
				console.identity.subject,
				console.identity.epoch,
			])}
			routeId={params.userId}
			canWrite={console.canWrite}
			revalidate={console.revalidate}
			onCanonicalize={(userId) =>
				void navigate({
					to: '/admin/users/$userId',
					params: { userId },
					replace: true,
				})
			}
			onDeleted={() =>
				void navigate({
					to: '/admin/users',
					search: validateUsersSearch({}),
					replace: true,
				})
			}
		/>
	)
}
