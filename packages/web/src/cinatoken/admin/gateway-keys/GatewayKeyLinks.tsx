/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import type {
	GatewayKeyRow,
	GatewayKeysCapabilities,
} from './gateway-key-contracts'

const prefix = 'cinatoken.adminGatewayKeys.'
export function GatewayKeyLinks(props: {
	row: GatewayKeyRow
	capabilities: GatewayKeysCapabilities
}) {
	const { t } = useTranslation()
	const links = [
		{
			visible: props.capabilities.user_detail,
			label: 'userDetail',
			href: '/admin/users/' + encodeURIComponent(props.row.user_id),
		},
		{
			visible: props.capabilities.request_logs,
			label: 'requestLogs',
			href:
				'/admin/request-logs?api_key_id=' + encodeURIComponent(props.row.id),
		},
		{
			visible: props.capabilities.budget_audit,
			label: 'budgetAudit',
			href: '/admin/audit-logs?api_key_id=' + encodeURIComponent(props.row.id),
		},
	]
	return (
		<div className='flex flex-wrap gap-x-3 gap-y-1 text-xs'>
			{links
				.filter((link) => link.visible)
				.map((link) => (
					<a
						key={link.label}
						href={link.href}
						className='text-primary underline'
					>
						{t(prefix + link.label)}
					</a>
				))}
		</div>
	)
}
