/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import type { McpServerSummary } from './mcp-contracts'
import { summarizeMcpServers } from './mcp-summary'

const prefix = 'cinatoken.adminMcp.'

export function McpOverview(props: { servers: McpServerSummary[] }) {
	const { t, i18n } = useTranslation()
	const summary = summarizeMcpServers(props.servers)
	const format = new Intl.NumberFormat(i18n.resolvedLanguage ?? 'en')
	const metrics = [
		{ key: 'totalServers', value: summary.total },
		{ key: 'enabledItems', value: summary.enabledItems },
		{ key: 'pendingItems', value: summary.pendingItems },
		{ key: 'syncFailedServers', value: summary.errorServers },
	]
	return (
		<section aria-label={t(prefix + 'overview')} className='min-w-0'>
			<dl className='grid min-w-0 grid-cols-2 gap-3 lg:grid-cols-4'>
				{metrics.map((metric) => (
					<div
						key={metric.key}
						className='bg-card flex min-w-0 flex-col gap-2 rounded-xl border p-4'
					>
						<dt className='text-muted-foreground text-xs break-words'>
							{t(prefix + metric.key)}
						</dt>
						<dd className='text-2xl font-semibold break-words tabular-nums'>
							{format.format(metric.value)}
						</dd>
					</div>
				))}
			</dl>
		</section>
	)
}
