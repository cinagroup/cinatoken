/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from '@/components/ui/card'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { McpField, McpNotice, McpStatus, mcpPrefix } from './McpFields'
import { McpLastSync } from './McpLastSync'
import { McpPricingSummary } from './McpPricingSummary'
import type { McpServerSummary } from './mcp-contracts'
import { filterMcpServers, type McpSearch } from './mcp-domain'
import { summarizeMcpServers } from './mcp-summary'

export function McpServerList(props: {
	servers: McpServerSummary[]
	search: McpSearch
	busy: boolean
	timezone?: string | null
	currency?: 'USD' | 'CNY' | null
	onSearch: (search: McpSearch) => void
}) {
	const { t, i18n } = useTranslation()
	const id = useId()
	const summary = summarizeMcpServers(props.servers)
	const counts = {
		all: summary.total,
		active: summary.active,
		disabled: summary.disabled,
		pending: summary.pendingServers,
		error: summary.errorServers,
	}
	const number = new Intl.NumberFormat(i18n.resolvedLanguage ?? 'en')
	const filtered = filterMcpServers(props.servers, props.search)
	const pageKey = JSON.stringify([
		props.search.q,
		props.search.filter,
		filtered.map((row) => row.id),
	])
	const [paging, setPaging] = useState<{ key: string; page: number } | null>(
		null
	)
	// Discard the old page so returning to a previous query cannot restore it.
	if (paging !== null && paging.key !== pageKey) setPaging(null)
	const page = paging?.key === pageKey ? paging.page : 1
	const visible = filtered.slice((page - 1) * 20, page * 20)
	return (
		<section className='flex min-w-0 flex-col gap-4'>
			<FieldGroup className='grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto]'>
				<McpField
					label='search'
					type='search'
					maxLength={200}
					value={props.search.q}
					onChange={(q) => props.onSearch({ ...props.search, q })}
				/>
				<Field>
					<FieldLabel htmlFor={id}>{t(mcpPrefix + 'filter')}</FieldLabel>
					<NativeSelect
						id={id}
						value={props.search.filter}
						className='w-full'
						onChange={(event) =>
							props.onSearch({
								...props.search,
								filter: event.target.value as McpSearch['filter'],
							})
						}
					>
						{(['all', 'active', 'disabled', 'pending', 'error'] as const).map(
							(value) => (
								<NativeSelectOption value={value} key={value}>
									{t(
										mcpPrefix + (value === 'error' ? 'syncFailedFilter' : value)
									)}{' '}
									({number.format(counts[value])})
								</NativeSelectOption>
							)
						)}
					</NativeSelect>
				</Field>
			</FieldGroup>
			<div className='flex flex-wrap items-center justify-between gap-3'>
				<p role='status' className='text-muted-foreground text-sm'>
					{t(mcpPrefix + 'serverMatchCount', {
						matched: number.format(filtered.length),
						total: number.format(props.servers.length),
					})}
				</p>
				{(props.search.q !== '' || props.search.filter !== 'all') && (
					<Button
						variant='outline'
						disabled={props.busy}
						onClick={() =>
							props.onSearch({ ...props.search, q: '', filter: 'all' })
						}
					>
						{t(mcpPrefix + 'clearServerFilters')}
					</Button>
				)}
			</div>
			{props.servers.length === 0 && <McpNotice message='serverCatalogEmpty' />}
			{props.servers.length > 0 && filtered.length === 0 && (
				<McpNotice message='empty' />
			)}
			<div className='grid min-w-0 gap-4 xl:grid-cols-2'>
				{visible.map((server) => (
					<Card key={server.id} className='min-w-0'>
						<CardHeader>
							<div className='flex items-start justify-between gap-3'>
								<CardTitle className='min-w-0 break-all'>
									{server.name}
								</CardTitle>
								<McpStatus status={server.status} />
							</div>
							<CardDescription className='font-mono break-all'>
								{server.slug}
							</CardDescription>
						</CardHeader>
						<CardContent className='flex min-w-0 flex-col gap-3'>
							{server.description && (
								<p className='text-muted-foreground text-sm break-words whitespace-pre-wrap'>
									{server.description}
								</p>
							)}
							<p
								className='truncate font-mono text-xs'
								title={server.urlMasked}
							>
								{server.urlMasked}
							</p>
							<p className='text-muted-foreground text-sm'>
								{t(mcpPrefix + 'enabled')}: {server.enabledCount} ·{' '}
								{t(mcpPrefix + 'pending')}: {server.pendingCount}
							</p>
							<McpLastSync
								value={server.lastSyncedAt}
								timezone={props.timezone}
							/>
							{server.lastSyncError && <McpNotice message='syncError' />}
							<McpPricingSummary
								rule={server.pricing}
								currency={props.currency ?? null}
							/>
						</CardContent>
						<CardFooter>
							<Button
								variant='outline'
								disabled={props.busy}
								onClick={() =>
									props.onSearch({
										...props.search,
										server: server.id,
										kind: 'tool',
										itemFilter: 'all',
										itemQuery: '',
									})
								}
							>
								{t(mcpPrefix + 'open')}
							</Button>
						</CardFooter>
					</Card>
				))}
			</div>
			{filtered.length > 20 && (
				<nav
					className='flex items-center justify-center gap-3'
					aria-label={t(mcpPrefix + 'title')}
				>
					<Button
						variant='outline'
						disabled={props.busy || page <= 1}
						onClick={() => setPaging({ key: pageKey, page: page - 1 })}
					>
						{t(mcpPrefix + 'previous')}
					</Button>
					<span>{t(mcpPrefix + 'page', { page })}</span>
					<Button
						variant='outline'
						disabled={props.busy || page * 20 >= filtered.length}
						onClick={() => setPaging({ key: pageKey, page: page + 1 })}
					>
						{t(mcpPrefix + 'next')}
					</Button>
				</nav>
			)}
		</section>
	)
}
