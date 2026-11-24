/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { formatUserDetailTime } from '../user-detail/user-detail-format'
import { mcpPrefix } from './McpFields'
import { parseMcpSyncTime } from './mcp-sync-time'

export function McpLastSync(props: {
	value: string | null
	timezone?: string | null
}) {
	const { t, i18n } = useTranslation()
	const parsed = parseMcpSyncTime(props.value)
	let value: ReactNode = t(mcpPrefix + 'syncTimeUnavailable')
	if (parsed.status === 'missing') value = t(mcpPrefix + 'noSyncRecorded')
	if (parsed.status === 'valid') {
		value = (
			<time dateTime={parsed.iso}>
				{formatUserDetailTime(
					parsed.iso,
					i18n.resolvedLanguage ?? 'en',
					props.timezone ?? null
				)}
			</time>
		)
	}
	return (
		<p className='text-muted-foreground min-w-0 text-sm break-words'>
			{t(mcpPrefix + 'lastSync')}: {value}
		</p>
	)
}
