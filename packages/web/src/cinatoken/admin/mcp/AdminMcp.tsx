/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { AdminDomainRecoveryDialog } from '../AdminDomainRecoveryDialog'
import { AdminListTimezone } from '../users/AdminListTimezone'
import { McpCatalog } from './McpCatalog'
import { McpClientTest } from './McpClientTest'
import { McpConfirmDialog } from './McpConfirmDialog'
import { McpDefinitionComparison } from './McpDefinitionComparison'
import { McpNotice, mcpPrefix } from './McpFields'
import { McpOverview } from './McpOverview'
import { McpPricingDialog } from './McpPricingDialog'
import { McpServerDetailCard } from './McpServerDetailCard'
import { McpServerForm } from './McpServerForm'
import { McpServerList } from './McpServerList'
import type {
	McpCatalogItem,
	McpConnectionTest,
	McpPricingRule,
	McpSyncSummary,
} from './mcp-contracts'
import { effectiveMcpPricing, mcpInvocationHref } from './mcp-domain'
import { mcpServerDraftFrom, type McpServerDraft } from './mcp-input'
import { assertMcpReviewCurrent } from './mcp-review'
import { useMcpAdmin, type McpAdminProps } from './use-mcp-admin'

type Confirmation =
	| { kind: 'delete' }
	| { kind: 'sync' }
	| { kind: 'accept'; item: McpCatalogItem }
export function AdminMcp(props: McpAdminProps) {
	const { t } = useTranslation()
	const state = useMcpAdmin(props)
	const [editing, setEditing] = useState<'create' | 'edit' | null>(null)
	const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
	const [priceItem, setPriceItem] = useState<McpCatalogItem | null>(null)
	const [test, setTest] = useState<McpConnectionTest | null>(null)
	const [sync, setSync] = useState<McpSyncSummary | null>(null)
	const detail = state.detail
	const server = detail?.server
	async function save(draft: McpServerDraft): Promise<boolean> {
		if (editing === 'create') {
			const result = await state.write((options) =>
				props.api.createMcpServer(draft, options)
			)
			if (result.ok) {
				setEditing(null)
				props.onSearch({
					...props.search,
					server: result.value.id,
					invalidTarget: undefined,
					kind: 'tool',
					itemFilter: 'all',
					itemQuery: '',
				})
			}
			return result.ok
		}
		if (!server) return false
		const result = await state.write((options) =>
			props.api.updateMcpServer(server.id, draft, server, options)
		)
		if (result.ok) setEditing(null)
		return result.ok
	}
	async function confirm(): Promise<void> {
		if (!confirmation || !server) return
		const action = confirmation
		if (action.kind === 'sync') {
			setTest(null)
			setSync(null)
		}
		const result = await state.write(
			async (options) => {
				if (action.kind === 'delete')
					return props.api.deleteMcpServer(server.id, options)
				if (action.kind === 'sync')
					return props.api.syncMcpServer(server.id, options)
				const latest = await props.api.getMcpServer(server.id, options)
				const item = latest.items.find((row) => row.id === action.item.id)
				try {
					assertMcpReviewCurrent(action.item, item)
				} catch (error) {
					setConfirmation(null)
					throw error
				}
				return props.api.acceptMcpItemChange(server.id, action.item.id, options)
			},
			{
				refresh: action.kind !== 'delete',
				refreshOnFailure: action.kind === 'sync',
			}
		)
		if (action.kind === 'sync') setConfirmation(null)
		if (result.ok) {
			setConfirmation(null)
			if (action.kind === 'delete')
				props.onSearch({ ...props.search, server: undefined })
			if (action.kind === 'sync') setSync(result.value as McpSyncSummary)
		}
	}
	async function connectionTest(): Promise<void> {
		if (!server) return
		setTest(null)
		setSync(null)
		const result = await state.write(
			(options) => props.api.testMcpServer(server.id, options),
			{ refresh: false }
		)
		if (result.ok) setTest(result.value)
	}
	async function toggleServer(): Promise<void> {
		if (!server) return
		await state.write((options) =>
			props.api.updateMcpServer(
				server.id,
				{
					...mcpServerDraftFrom(server),
					status: server.status === 'active' ? 'disabled' : 'active',
				},
				server,
				options
			)
		)
	}
	async function setStatus(
		ids: string[],
		status: 'enabled' | 'disabled'
	): Promise<void> {
		if (!server || ids.length === 0) return
		await state.write((options) =>
			props.api.setMcpItemStatus(server.id, ids, status, options)
		)
	}
	async function savePricing(pricing: McpPricingRule | null): Promise<boolean> {
		if (!server || !priceItem) return false
		const result = await state.write((options) =>
			props.api.setMcpItemPricing(server.id, priceItem.id, pricing, options)
		)
		if (result.ok) setPriceItem(null)
		return result.ok
	}
	let listContent = !state.error ? <Skeleton className='h-64 w-full' /> : null
	if (state.list)
		listContent = (
			<McpServerList
				servers={state.list}
				search={props.search}
				busy={state.busy}
				currency={state.currency}
				timezone={state.display?.timezone ?? null}
				onSearch={props.onSearch}
			/>
		)
	return (
		<main className='flex min-w-0 flex-col gap-6'>
			<header className='flex flex-wrap items-start justify-between gap-4'>
				<div>
					<h1 className='text-2xl font-semibold'>{t(mcpPrefix + 'title')}</h1>
					<p className='text-muted-foreground mt-2 max-w-3xl text-sm'>
						{t(mcpPrefix + 'subtitle')}
					</p>
				</div>
				<div className='flex flex-wrap items-center gap-3'>
					<a
						href={mcpInvocationHref()}
						className='text-primary text-sm underline-offset-2 hover:underline'
					>
						{t(mcpPrefix + 'invocations')}
					</a>
					<a
						href='/gateway/mcp'
						className='text-primary text-sm underline-offset-2 hover:underline'
					>
						{t(mcpPrefix + 'advanced')}
					</a>
					<Button
						variant='outline'
						disabled={state.busy}
						onClick={state.refresh}
					>
						{t(mcpPrefix + 'refresh')}
					</Button>
					<Button
						disabled={!state.writeAllowed}
						onClick={() => setEditing('create')}
					>
						{t(mcpPrefix + 'create')}
					</Button>
				</div>
			</header>
			<AdminListTimezone display={state.display} />
			{state.list && !props.search.server && !props.search.invalidTarget && (
				<McpOverview servers={state.list} />
			)}
			<AdminDomainRecoveryDialog recovery={state.recovery} busy={state.busy} />
			{state.message && (
				<McpNotice
					message={state.message}
					destructive={state.message !== 'saved'}
				/>
			)}
			{props.search.invalidTarget && (
				<McpNotice message='invalidInput' destructive />
			)}
			{state.error && (
				<div className='flex flex-col gap-3'>
					<McpNotice message={state.error} destructive />
					<Button
						variant='outline'
						onClick={state.refresh}
						disabled={state.busy}
					>
						{t(mcpPrefix + 'retry')}
					</Button>
				</div>
			)}
			{props.search.server || props.search.invalidTarget ? (
				<>
					<Button
						variant='outline'
						className='self-start'
						disabled={state.busy}
						onClick={() =>
							props.onSearch({
								...props.search,
								server: undefined,
								invalidTarget: undefined,
							})
						}
					>
						{t(mcpPrefix + 'back')}
					</Button>
					{server && detail ? (
						<>
							<McpServerDetailCard
								server={server}
								writeAllowed={state.writeAllowed}
								busy={state.busy}
								secrets={state.secrets}
								currency={state.currency}
								timezone={state.display?.timezone ?? null}
								test={test}
								sync={sync}
								onEdit={() => setEditing('edit')}
								onTest={() => void connectionTest()}
								onSync={() => setConfirmation({ kind: 'sync' })}
								onToggle={() => void toggleServer()}
								onDelete={() => setConfirmation({ kind: 'delete' })}
								onReveal={() => void state.reveal()}
							/>
							<McpCatalog
								detail={detail}
								search={props.search}
								currency={state.currency}
								busy={!state.writeAllowed}
								onSearch={props.onSearch}
								onStatus={(ids, status) => void setStatus(ids, status)}
								onAccept={(item) => setConfirmation({ kind: 'accept', item })}
								onPricing={setPriceItem}
							/>
						</>
					) : (
						!state.error &&
						!props.search.invalidTarget && <Skeleton className='h-64 w-full' />
					)}
				</>
			) : (
				listContent
			)}

			{state.list &&
				!props.search.invalidTarget &&
				(!props.search.server || server) && (
					<McpClientTest
						api={props.api}
						session={props.session}
						servers={state.list}
						initialSlug={server?.slug ?? ''}
					/>
				)}
			{editing && (
				<McpServerForm
					key={editing}
					current={editing === 'edit' ? server : undefined}
					currency={state.currency}
					busy={state.busy}
					canSave={state.writeAllowed}
					failure={state.message}
					onClose={() => setEditing(null)}
					onSave={save}
				/>
			)}
			{priceItem && server && (
				<McpPricingDialog
					rule={effectiveMcpPricing(priceItem, server)}
					currency={state.currency}
					busy={state.busy}
					canSave={state.writeAllowed}
					failure={state.message}
					onClose={() => setPriceItem(null)}
					onSave={savePricing}
				/>
			)}
			{confirmation && (
				<McpConfirmDialog
					title={
						{ delete: 'delete', sync: 'sync', accept: 'accept' }[
							confirmation.kind
						]
					}
					message={
						{
							delete: 'deleteHint',
							sync: 'confirmSync',
							accept: 'confirmAccept',
						}[confirmation.kind]
					}
					busy={state.busy}
					canConfirm={state.writeAllowed}
					error={state.message !== 'saved' ? state.message : null}
					destructive={confirmation.kind === 'delete'}
					onClose={() => setConfirmation(null)}
					onConfirm={() => void confirm()}
				>
					{confirmation.kind === 'accept' && (
						<>
							<p className='font-mono text-sm break-all'>
								{confirmation.item.exposedName}
							</p>
							<McpDefinitionComparison
								current={confirmation.item.definition}
								pending={confirmation.item.pendingDefinition}
								sideBySide
							/>
						</>
					)}
				</McpConfirmDialog>
			)}
		</main>
	)
}
