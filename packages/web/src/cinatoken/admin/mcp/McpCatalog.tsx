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
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { McpDefinitionComparison } from './McpDefinitionComparison'
import { McpField, McpNotice, McpStatus, mcpPrefix } from './McpFields'
import { McpPricingDetails } from './McpPricingFields'
import type { McpCatalogItem, McpServerDetail } from './mcp-contracts'
import {
	effectiveMcpPricing,
	filterMcpItems,
	newMcpItemIds,
	type McpSearch,
} from './mcp-domain'

export function McpCatalog(props: {
	detail: McpServerDetail
	search: McpSearch
	currency: 'USD' | 'CNY' | null
	busy: boolean
	onSearch: (search: McpSearch) => void
	onStatus: (ids: string[], status: 'enabled' | 'disabled') => void
	onAccept: (item: McpCatalogItem) => void
	onPricing: (item: McpCatalogItem) => void
}) {
	const { t, i18n } = useTranslation()
	const filterId = useId()
	const newIds = newMcpItemIds(props.detail.items, props.search.kind)
	const matched = filterMcpItems(props.detail.items, props.search)
	const kindTotal = props.detail.items.filter(
		(item) => item.kind === props.search.kind
	).length
	const number = new Intl.NumberFormat(i18n.resolvedLanguage ?? 'en')
	const pageKey = JSON.stringify([
		props.detail.server.id,
		props.search,
		matched.map((item) => item.id),
	])
	const [pagination, setPagination] = useState({ key: pageKey, page: 1 })
	// A search round trip must not revive an old page or selection.
	if (pagination.key !== pageKey) setPagination({ key: pageKey, page: 1 })
	const page = pagination.key === pageKey ? pagination.page : 1
	const visible = matched.slice((page - 1) * 40, page * 40)
	const selectable = visible.filter((item) => item.status !== 'removed')
	const selectionKey = JSON.stringify([
		props.detail.server.id,
		props.search,
		page,
		props.detail.items.map((item) => [item.id, item.status, item.reviewState]),
	])
	const [selection, setSelection] = useState<{
		key: string
		ids: string[]
	} | null>(null)
	if (selection !== null && selection.key !== selectionKey) setSelection(null)
	const selected = selection?.key === selectionKey ? selection.ids : []
	function select(id: string, checked: boolean): void {
		setSelection({
			key: selectionKey,
			ids: checked
				? [...new Set([...selected, id])]
				: selected.filter((value) => value !== id),
		})
	}
	const allSelected =
		selectable.length > 0 &&
		selectable.every((item) => selected.includes(item.id))
	return (
		<section className='flex min-w-0 flex-col gap-4'>
			<McpNotice message='syncHint' />
			<ToggleGroup
				variant='outline'
				aria-label={t(mcpPrefix + 'kind')}
				value={[props.search.kind]}
				onValueChange={(values) => {
					const kind = values[0]
					if (kind === 'tool' || kind === 'prompt' || kind === 'resource')
						props.onSearch({
							...props.search,
							kind,
							itemFilter: 'all',
							itemQuery: '',
						})
				}}
			>
				{(['tool', 'prompt', 'resource'] as const).map((kind) => (
					<ToggleGroupItem key={kind} value={kind}>
						{t(mcpPrefix + kind)} ·{' '}
						{
							props.detail.items.filter(
								(item) => item.kind === kind && item.status !== 'removed'
							).length
						}
					</ToggleGroupItem>
				))}
			</ToggleGroup>
			<FieldGroup className='grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto]'>
				<McpField
					label='itemSearch'
					value={props.search.itemQuery}
					onChange={(itemQuery) =>
						props.onSearch({ ...props.search, itemQuery })
					}
					type='search'
					maxLength={200}
				/>
				<Field>
					<FieldLabel htmlFor={filterId}>
						{t(mcpPrefix + 'itemFilter')}
					</FieldLabel>
					<NativeSelect
						id={filterId}
						value={props.search.itemFilter}
						onChange={(event) =>
							props.onSearch({
								...props.search,
								itemFilter: event.target.value as McpSearch['itemFilter'],
							})
						}
						className='w-full'
					>
						{(
							['all', 'pending', 'enabled', 'disabled', 'removed'] as const
						).map((value) => (
							<NativeSelectOption key={value} value={value}>
								{t(mcpPrefix + (value === 'all' ? 'currentItems' : value))}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</Field>
			</FieldGroup>
			<div className='bg-muted/40 flex flex-wrap items-center justify-between gap-3 rounded-lg p-3'>
				<Field orientation='horizontal' className='w-auto'>
					<Checkbox
						id={`${filterId}-select`}
						checked={allSelected}
						indeterminate={selected.length > 0 && !allSelected}
						disabled={props.busy || selectable.length === 0}
						onCheckedChange={(checked) =>
							setSelection({
								key: selectionKey,
								ids: checked ? selectable.map((item) => item.id) : [],
							})
						}
					/>
					<FieldLabel htmlFor={`${filterId}-select`}>
						{selected.length
							? t(mcpPrefix + 'selected', { count: selected.length })
							: t(mcpPrefix + 'selectVisible')}
					</FieldLabel>
				</Field>
				<div className='flex flex-wrap gap-2'>
					<Button
						variant='outline'
						disabled={
							props.busy ||
							!selectable.some(
								(item) =>
									selected.includes(item.id) && item.status === 'disabled'
							)
						}
						onClick={() =>
							props.onStatus(
								selectable
									.filter(
										(item) =>
											selected.includes(item.id) && item.status === 'disabled'
									)
									.map((item) => item.id),
								'enabled'
							)
						}
					>
						{t(mcpPrefix + 'enable')}
					</Button>
					<Button
						variant='outline'
						disabled={
							props.busy ||
							!selectable.some(
								(item) =>
									selected.includes(item.id) && item.status === 'enabled'
							)
						}
						onClick={() =>
							props.onStatus(
								selectable
									.filter(
										(item) =>
											selected.includes(item.id) && item.status === 'enabled'
									)
									.map((item) => item.id),
								'disabled'
							)
						}
					>
						{t(mcpPrefix + 'disable')}
					</Button>
				</div>
			</div>
			{newIds.length > 0 && selected.length === 0 && (
				<div className='flex flex-col items-start gap-2'>
					<Button
						variant='outline'
						disabled={props.busy}
						aria-describedby={`${filterId}-new-hint`}
						onClick={() => props.onStatus(newIds, 'enabled')}
					>
						{t(mcpPrefix + 'enableNew', {
							count: newIds.length,
							formattedCount: new Intl.NumberFormat(
								i18n.resolvedLanguage ?? 'en'
							).format(newIds.length),
						})}
					</Button>
					<p
						id={`${filterId}-new-hint`}
						className='text-muted-foreground text-xs'
					>
						{t(mcpPrefix + 'enableNewHint')}
					</p>
				</div>
			)}
			<div className='flex flex-wrap items-center justify-between gap-3'>
				<p role='status' className='text-muted-foreground text-sm'>
					{t(mcpPrefix + 'itemMatchCount', {
						matched: number.format(matched.length),
						total: number.format(kindTotal),
					})}
				</p>
				{(props.search.itemQuery !== '' ||
					props.search.itemFilter !== 'all') && (
					<Button
						variant='outline'
						disabled={props.busy}
						onClick={() =>
							props.onSearch({
								...props.search,
								itemQuery: '',
								itemFilter: 'all',
							})
						}
					>
						{t(mcpPrefix + 'clearItemFilters')}
					</Button>
				)}
			</div>
			{kindTotal === 0 && <McpNotice message='itemCatalogEmpty' />}
			{kindTotal > 0 && matched.length === 0 && <McpNotice message='noItems' />}
			<div className='grid min-w-0 gap-4 xl:grid-cols-2'>
				{visible.map((item) => (
					<McpCatalogCard
						key={item.id}
						item={item}
						detail={props.detail}
						selected={selected.includes(item.id)}
						currency={props.currency}
						busy={props.busy}
						onSelect={(checked) => select(item.id, checked)}
						onStatus={props.onStatus}
						onAccept={props.onAccept}
						onPricing={props.onPricing}
					/>
				))}
			</div>
			{matched.length > 40 && (
				<div className='flex flex-wrap items-center gap-3'>
					<Button
						variant='outline'
						disabled={props.busy || page <= 1}
						onClick={() => setPagination({ key: pageKey, page: page - 1 })}
					>
						{t(mcpPrefix + 'previous')}
					</Button>
					<span className='text-sm'>{t(mcpPrefix + 'page', { page })}</span>
					<Button
						variant='outline'
						disabled={props.busy || page * 40 >= matched.length}
						onClick={() => setPagination({ key: pageKey, page: page + 1 })}
					>
						{t(mcpPrefix + 'next')}
					</Button>
				</div>
			)}
		</section>
	)
}
function McpCatalogCard(props: {
	item: McpCatalogItem
	detail: McpServerDetail
	selected: boolean
	currency: 'USD' | 'CNY' | null
	busy: boolean
	onSelect: (checked: boolean) => void
	onStatus: (ids: string[], status: 'enabled' | 'disabled') => void
	onAccept: (item: McpCatalogItem) => void
	onPricing: (item: McpCatalogItem) => void
}) {
	const { t } = useTranslation()
	const item = props.item
	return (
		<Card className='min-w-0'>
			<CardHeader>
				<div className='flex items-start justify-between gap-3'>
					<CardTitle className='min-w-0 break-all'>
						{item.exposedName}
					</CardTitle>
					<Checkbox
						aria-label={`${t(mcpPrefix + 'selectItem')} ${item.exposedName}`}
						checked={props.selected}
						disabled={props.busy || item.status === 'removed'}
						onCheckedChange={props.onSelect}
					/>
				</div>
				<CardDescription className='break-all'>
					{item.upstreamKey}
				</CardDescription>
				<div className='flex flex-wrap gap-2'>
					<McpStatus status={item.status} />
					{item.reviewState !== 'none' && (
						<McpStatus status={item.reviewState} />
					)}
				</div>
			</CardHeader>
			<CardContent className='flex min-w-0 flex-col gap-4'>
				<McpDefinitionComparison
					current={item.definition}
					pending={item.pendingDefinition}
				/>
				{item.kind === 'tool' && (
					<section className='flex flex-col gap-3'>
						<h3 className='text-sm font-medium'>
							{t(
								mcpPrefix +
									(item.pricingState === 'inherit'
										? 'defaultPricing'
										: 'pricing')
							)}
						</h3>
						{item.pricingState === undefined && item.pricing === null ? (
							<McpNotice message='pricingUnknown' />
						) : (
							<McpPricingDetails
								rule={effectiveMcpPricing(item, props.detail.server)}
								currency={props.currency}
							/>
						)}
					</section>
				)}
			</CardContent>
			<CardFooter className='flex flex-wrap gap-2'>
				<Button
					variant='outline'
					disabled={props.busy || item.status === 'removed'}
					onClick={() =>
						props.onStatus(
							[item.id],
							item.status === 'enabled' ? 'disabled' : 'enabled'
						)
					}
				>
					{t(mcpPrefix + (item.status === 'enabled' ? 'disable' : 'enable'))}
				</Button>
				{item.reviewState === 'changed' &&
					item.pendingDefinition !== null &&
					item.status !== 'removed' && (
						<Button
							variant='outline'
							disabled={props.busy}
							onClick={() => props.onAccept(item)}
						>
							{t(mcpPrefix + 'accept')}
						</Button>
					)}
				{item.kind === 'tool' && (
					<Button
						variant='outline'
						disabled={
							props.busy || !props.currency || item.status === 'removed'
						}
						onClick={() => props.onPricing(item)}
					>
						{t(mcpPrefix + 'editPricing')}
					</Button>
				)}
			</CardFooter>
		</Card>
	)
}
