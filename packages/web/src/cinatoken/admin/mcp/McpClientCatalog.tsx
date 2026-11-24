/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { safeLogText } from '../request-logs/request-log-domain'
import { McpField, McpJson, mcpPrefix } from './McpFields'
import type { McpClientMethod } from './mcp-client'
import {
	filterMcpClientCatalog,
	paginateMcpClientCatalog,
} from './mcp-client-catalog'
import type { McpServerSummary } from './mcp-contracts'

export function McpClientCatalog(props: {
	entries: Record<string, unknown>[]
	method: McpClientMethod
	slug: string
	servers: readonly Pick<McpServerSummary, 'slug' | 'name'>[]
}) {
	const { t, i18n } = useTranslation()
	const [search, setSearch] = useState('')
	const [page, setPage] = useState(1)
	const catalog = useMemo(
		() =>
			filterMcpClientCatalog(
				props.entries,
				props.method,
				props.slug,
				props.servers,
				search
			),
		[props.entries, props.method, props.slug, props.servers, search]
	)
	const current = paginateMcpClientCatalog(catalog.groups, page)
	const number = new Intl.NumberFormat(i18n.resolvedLanguage ?? 'en')
	function changeSearch(value: string): void {
		setSearch(value)
		setPage(1)
	}
	let emptyMessage: string | null = null
	if (catalog.total === 0) emptyMessage = t(mcpPrefix + 'clientCatalogEmpty')
	else if (catalog.matched === 0)
		emptyMessage = t(mcpPrefix + 'clientCatalogNoMatches')
	return (
		<section
			className='flex min-w-0 flex-col gap-4'
			aria-label={t(mcpPrefix + 'grouped')}
		>
			<McpField
				label='clientCatalogSearch'
				hint='clientCatalogSearchHint'
				type='search'
				value={search}
				onChange={changeSearch}
				maxLength={200}
			/>
			<div className='flex flex-wrap items-center justify-between gap-3'>
				<p className='text-muted-foreground text-sm' role='status'>
					{t(mcpPrefix + 'clientCatalogCount', {
						from: number.format(current.from),
						to: number.format(current.to),
						matched: number.format(catalog.matched),
						total: number.format(catalog.total),
					})}
				</p>
				<Button
					variant='outline'
					disabled={!search}
					onClick={() => changeSearch('')}
				>
					{t(mcpPrefix + 'clientCatalogClear')}
				</Button>
			</div>
			{emptyMessage && (
				<p
					role='status'
					className='text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm'
				>
					{emptyMessage}
				</p>
			)}
			{current.groups.map((group) => (
				<section key={group.slug} className='min-w-0 rounded-lg border'>
					<header className='bg-muted/40 flex min-w-0 flex-wrap items-center justify-between gap-3 border-b p-3'>
						<div className='min-w-0'>
							<h3 className='text-sm font-semibold break-all'>
								{group.name ||
									group.slug ||
									t(mcpPrefix + 'clientCatalogUnknownServer')}
							</h3>
							{group.slug && (
								<p className='text-muted-foreground font-mono text-xs break-all'>
									{group.slug}
								</p>
							)}
						</div>
						<p className='text-muted-foreground text-xs'>
							{t(mcpPrefix + 'clientCatalogGroupCount', {
								count: group.entries.length,
								formattedCount: number.format(group.entries.length),
							})}
						</p>
					</header>
					<div className='divide-y'>
						{group.entries.map((entry, index) => (
							<McpClientEntry
								key={`${search}-${current.page}-${index}`}
								entry={entry}
								method={props.method}
							/>
						))}
					</div>
				</section>
			))}
			{current.pages > 1 && (
				<nav
					aria-label={t(mcpPrefix + 'clientCatalogPagination')}
					className='flex flex-wrap items-center gap-3'
				>
					<Button
						variant='outline'
						disabled={current.page <= 1}
						onClick={() => setPage(current.page - 1)}
					>
						{t(mcpPrefix + 'previous')}
					</Button>
					<span className='text-sm'>
						{t(mcpPrefix + 'page', { page: number.format(current.page) })}
					</span>
					<Button
						variant='outline'
						disabled={current.page >= current.pages}
						onClick={() => setPage(current.page + 1)}
					>
						{t(mcpPrefix + 'next')}
					</Button>
				</nav>
			)}
		</section>
	)
}

function McpClientEntry(props: {
	entry: Record<string, unknown>
	method: McpClientMethod
}) {
	const { t } = useTranslation()
	const identifier =
		props.method === 'resources/list' ? props.entry.uri : props.entry.name
	let title = props.entry.title
	if (typeof title !== 'string' && props.method === 'resources/list')
		title = props.entry.name
	return (
		<article
			className='flex min-w-0 flex-col gap-2 p-3'
			aria-label={t(mcpPrefix + 'clientCatalogEntry', {
				identifier:
					typeof identifier === 'string' ? safeLogText(identifier) : '—',
			})}
		>
			<h4 className='font-mono text-sm font-medium break-all'>
				{typeof identifier === 'string' ? safeLogText(identifier) : '—'}
			</h4>
			{typeof title === 'string' && title && (
				<p className='text-sm break-words whitespace-pre-wrap'>
					{safeLogText(title)}
				</p>
			)}
			{typeof props.entry.description === 'string' &&
				props.entry.description && (
					<McpClientDescription text={safeLogText(props.entry.description)} />
				)}
			{typeof props.entry.mimeType === 'string' && props.entry.mimeType && (
				<p className='text-muted-foreground font-mono text-xs break-all'>
					{safeLogText(props.entry.mimeType)}
				</p>
			)}
			<McpJson value={props.entry} label='clientCatalogEntryJson' />
		</article>
	)
}

function McpClientDescription(props: { text: string }) {
	const { t } = useTranslation()
	const [expanded, setExpanded] = useState(false)
	const long = props.text.length > 320
	const text = long && !expanded ? props.text.slice(0, 320) + '…' : props.text
	return (
		<div className='min-w-0'>
			<p className='text-muted-foreground text-sm break-words whitespace-pre-wrap'>
				{text}
			</p>
			{long && (
				<Button
					variant='ghost'
					size='sm'
					aria-expanded={expanded}
					onClick={() => setExpanded(!expanded)}
				>
					{t(
						mcpPrefix + (expanded ? 'clientCatalogLess' : 'clientCatalogMore')
					)}
				</Button>
			)}
		</div>
	)
}
