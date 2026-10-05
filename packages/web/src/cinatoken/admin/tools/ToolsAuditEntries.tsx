/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import type { ToolAuditPage } from './tools-audit'
import {
	toolsPrefix,
	toolProviderLabelKey,
	type ToolFamily,
} from './tools-domain'

export function ToolsAuditEntries(props: {
	page: ToolAuditPage
	family: ToolFamily
}) {
	const { t } = useTranslation()
	if (!props.page.entries.length)
		return (
			<p className='text-muted-foreground text-sm'>
				{t(toolsPrefix + 'auditEmpty')}
			</p>
		)
	return (
		<ol className='space-y-3'>
			{props.page.entries.map((entry) => (
				<li
					key={entry.id}
					className='min-w-0 space-y-2 rounded-lg border p-3 text-sm'
				>
					<p className='break-all'>
						<time>{entry.createdAt}</time> · <code>{entry.id}</code>
					</p>
					<p>
						{t(toolsPrefix + 'operation')}:{' '}
						{t(toolsPrefix + 'auditOperation_' + entry.action)} ·{' '}
						{entry.provider === null
							? t(toolsPrefix + 'none')
							: t(toolProviderLabelKey(props.family, entry.provider))}
					</p>
					<p className='break-all'>
						{t(toolsPrefix + 'auditActor')}: {entry.actorKind} · {entry.actorId}
					</p>
					<p className='break-all'>
						{t(toolsPrefix + 'auditReason')}: {entry.reason}
					</p>
					<p>
						{t(toolsPrefix + 'source')}:{' '}
						{t(toolsPrefix + 'auditSource_' + entry.source)}
					</p>
					<p className='break-all'>
						{t(toolsPrefix + 'auditFields')}:{' '}
						{entry.changedFields
							.map((row) => (row.provider ?? '') + ':' + row.field)
							.join(', ') || t(toolsPrefix + 'none')}
					</p>
					<ul>
						{entry.credentials.map((row, i) => (
							<li key={i} className='break-all'>
								{t(toolProviderLabelKey(props.family, row.provider))} ·{' '}
								{row.field} · {t(toolsPrefix + row.operation)} ·{' '}
								{t(
									toolsPrefix +
										(row.configuredBefore ? 'configured' : 'missing')
								)}{' '}
								→{' '}
								{t(
									toolsPrefix + (row.configuredAfter ? 'configured' : 'missing')
								)}
							</li>
						))}
					</ul>
					<details className='space-y-2'>
						<summary className='cursor-pointer'>
							{t(toolsPrefix + 'auditDetails')}
						</summary>
						<p>
							{t(toolsPrefix + 'auditActive')}:{' '}
							{entry.activeBefore === null
								? t(toolsPrefix + 'none')
								: t(toolProviderLabelKey(props.family, entry.activeBefore))}
							{' → '}
							{entry.activeAfter === null
								? t(toolsPrefix + 'none')
								: t(toolProviderLabelKey(props.family, entry.activeAfter))}
						</p>
						<p>{t(toolsPrefix + 'auditBeforeVersion')}</p>
						<code className='block text-xs break-all'>
							{entry.beforeVersion}
						</code>
						<p>{t(toolsPrefix + 'auditAfterVersion')}</p>
						<code className='block text-xs break-all'>
							{entry.afterVersion}
						</code>
					</details>
				</li>
			))}
		</ol>
	)
}
