/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import { ChainOperationConfirmation } from './ChainOperationConfirmation'
import { ChainRecords } from './ChainRecords'
import { ChainUnknownReview } from './ChainUnknownReview'
import type {
	AdminWithdrawalRow,
	ChainRecord,
} from './chain-operations-contracts'
import { chainWriteErrorKey } from './chain-operations-errors'
import {
	chainOperationsLocalPage,
	nftMintStatuses,
	withdrawalStatuses,
	type ChainOperationsSearch,
} from './chain-operations-search'
import type { ChainOperationsScreenProps } from './types'
import { useChainOperations } from './use-chain-operations'

const prefix = 'cinatoken.adminChainOperations.'
function ChainOperationsContent(props: ChainOperationsScreenProps) {
	const { t } = useTranslation()
	const [searchOverride, setSearchOverride] = useState<{
		base: string
		search: ChainOperationsSearch
	} | null>(null)
	const searchBase = JSON.stringify(props.search)
	const search =
		!props.onSearchChange && searchOverride?.base === searchBase
			? searchOverride.search
			: props.search
	const manager = useChainOperations({ ...props, search })
	const [confirmation, setConfirmation] = useState<{
		row: AdminWithdrawalRow | null
	} | null>(null)
	const [review, setReview] = useState(false)
	const withdrawals = props.kind === 'withdrawals'
	const rows =
		!manager.readBlocked &&
		!manager.query.isFetching &&
		!manager.query.error &&
		!search.invalid
			? (manager.query.data?.data ?? [])
			: []
	const page = chainOperationsLocalPage<ChainRecord>(rows, search.page)
	const statuses = withdrawals ? withdrawalStatuses : nftMintStatuses
	const queueConfigured = manager.query.data?.meta.queueConfigured === true
	function changeSearch(next: ChainOperationsSearch): void {
		if (props.onSearchChange) props.onSearchChange(next)
		else setSearchOverride({ base: searchBase, search: next })
	}
	let content = (
		<p className='text-muted-foreground rounded-xl border p-8 text-center'>
			{t(prefix + 'empty')}
		</p>
	)
	if (search.invalid)
		content = (
			<section role='alert' className='space-y-3 rounded-xl border p-5 text-sm'>
				<p>{t(prefix + 'invalidSearch')}</p>
				<Button
					type='button'
					variant='outline'
					onClick={() =>
						changeSearch({ status: 'all', page: 1, limit: 5, invalid: false })
					}
				>
					{t(prefix + 'clearFilters')}
				</Button>
			</section>
		)
	else if (manager.readBlocked)
		content = (
			<p
				role='alert'
				className='text-destructive rounded-xl border p-5 text-sm'
			>
				{t(prefix + 'accessDenied')}
			</p>
		)
	else if (manager.query.isFetching)
		content = (
			<p
				role='status'
				className='text-muted-foreground rounded-xl border p-8 text-center'
			>
				{t(prefix + 'loading')}
			</p>
		)
	else if (manager.query.error)
		content = (
			<p
				role='alert'
				className='text-destructive rounded-xl border p-5 text-sm'
			>
				{t(prefix + 'loadFailed')}
			</p>
		)
	else if (page.outOfRange)
		content = (
			<section className='space-y-3 rounded-xl border p-5 text-sm'>
				<p>{t(prefix + 'outOfRange')}</p>
				<Button
					type='button'
					variant='outline'
					onClick={() => changeSearch({ ...search, page: 1 })}
				>
					{t(prefix + 'firstPage')}
				</Button>
			</section>
		)
	else if (page.rows.length)
		content = (
			<ChainRecords
				rows={page.rows}
				withdrawals={withdrawals}
				canWrite={manager.canWrite}
				onReject={(row) => setConfirmation({ row })}
			/>
		)
	return (
		<main
			className='min-w-0 space-y-5 pb-12'
			data-chain-operation-kind={props.kind}
		>
			<header className='flex flex-wrap items-start justify-between gap-3'>
				<div className='min-w-0'>
					<h1 className='text-2xl font-semibold tracking-tight sm:text-3xl'>
						{t(prefix + (withdrawals ? 'withdrawalsTitle' : 'nftMintsTitle'))}
					</h1>
					<p className='text-muted-foreground mt-1 text-sm'>
						{t(
							prefix +
								(withdrawals ? 'withdrawalsSubtitle' : 'nftMintsSubtitle')
						)}
					</p>
				</div>
				<Button
					type='button'
					variant='outline'
					onClick={manager.refresh}
					disabled={manager.query.isFetching || manager.busy || search.invalid}
				>
					{t(prefix + 'refresh')}
				</Button>
			</header>
			<p className='text-muted-foreground text-sm'>
				{t(prefix + 'globalScope')}
			</p>
			<div className='flex flex-wrap items-end gap-3 rounded-xl border p-4'>
				<label className='grid gap-2 text-sm'>
					<span>{t(prefix + 'statusFilter')}</span>
					<select
						className='bg-background rounded-lg border px-3 py-2'
						value={search.status}
						disabled={manager.busy}
						onChange={(event) =>
							changeSearch({
								...search,
								status: event.target.value as ChainOperationsSearch['status'],
								page: 1,
								invalid: false,
							})
						}
					>
						<option value='all'>{t(prefix + 'all')}</option>
						{statuses.map((status) => (
							<option key={status} value={status}>
								{t(prefix + status)}
							</option>
						))}
					</select>
				</label>
				<label className='grid gap-2 text-sm'>
					<span>{t(prefix + 'batchSize')}</span>
					<select
						className='bg-background rounded-lg border px-3 py-2'
						value={search.limit}
						disabled={manager.busy}
						onChange={(event) =>
							changeSearch({ ...search, limit: Number(event.target.value) })
						}
					>
						{Array.from({ length: 20 }, (_, index) => index + 1).map(
							(limit) => (
								<option key={limit} value={limit}>
									{limit}
								</option>
							)
						)}
					</select>
				</label>
				<Button
					type='button'
					disabled={!manager.canWrite || !queueConfigured}
					onClick={() => setConfirmation({ row: null })}
				>
					{t(prefix + 'process')}
				</Button>
			</div>
			<p className='text-muted-foreground text-sm'>{t(prefix + 'queueHint')}</p>
			{manager.query.data && !queueConfigured && !manager.readBlocked && (
				<p role='status' className='rounded-xl border p-4 text-sm'>
					{t(prefix + 'queueUnavailable')}
				</p>
			)}
			{manager.writeDenied && (
				<p
					role='alert'
					className='text-destructive rounded-xl border p-4 text-sm'
				>
					{t(prefix + 'writeDenied')}
				</p>
			)}
			{manager.writeStatus !== 'ready' && !manager.busy && (
				<section
					role='alert'
					className='border-destructive/40 bg-destructive/5 space-y-3 rounded-xl border p-4 text-sm'
				>
					<p>
						{t(
							prefix +
								(manager.writeStatus === 'unavailable'
									? 'storageUnavailable'
									: 'unknownWrite')
						)}
					</p>
					{manager.writeStatus === 'pending' && (
						<>
							<p>{t(prefix + 'unknownHelp')}</p>
							<Button
								type='button'
								variant='outline'
								disabled={!manager.canRelease}
								onClick={() => setReview(true)}
							>
								{t(prefix + 'manualReview')}
							</Button>
						</>
					)}
				</section>
			)}
			{Boolean(manager.error) &&
				!confirmation &&
				!review &&
				manager.writeStatus === 'ready' && (
					<p
						role='alert'
						className='text-destructive rounded-xl border p-4 text-sm'
					>
						{t(prefix + chainWriteErrorKey(manager.error))}
					</p>
				)}
			{manager.notice && (
				<p role='status' className='rounded-xl border p-4 text-sm'>
					{t(prefix + manager.notice.kind, { count: manager.notice.count })}
				</p>
			)}
			{content}
			{!manager.readBlocked &&
				!manager.query.error &&
				!manager.query.isFetching &&
				!search.invalid &&
				manager.query.data && (
					<footer className='flex flex-wrap items-center justify-between gap-3 text-sm'>
						<div className='text-muted-foreground'>
							<p>{t(prefix + 'count', { count: rows.length })}</p>
							<p className='mt-1 text-xs'>{t(prefix + 'localPagination')}</p>
						</div>
						<div className='flex flex-wrap items-center gap-2'>
							<Button
								type='button'
								variant='outline'
								disabled={search.page <= 1 || manager.busy}
								onClick={() =>
									changeSearch({ ...search, page: search.page - 1 })
								}
							>
								{t(prefix + 'previous')}
							</Button>
							<span>
								{t(prefix + 'page', {
									page: search.page,
									total: page.totalPages,
								})}
							</span>
							<Button
								type='button'
								variant='outline'
								disabled={search.page >= page.totalPages || manager.busy}
								onClick={() =>
									changeSearch({ ...search, page: search.page + 1 })
								}
							>
								{t(prefix + 'next')}
							</Button>
						</div>
					</footer>
				)}
			{confirmation &&
				!manager.readBlocked &&
				!manager.writeDenied &&
				!search.invalid && (
					<ChainOperationConfirmation
						key={confirmation.row?.id ?? 'process'}
						row={confirmation.row}
						limit={search.limit}
						busy={manager.busy}
						disabled={!manager.canWrite && !manager.busy}
						error={manager.error}
						onClose={() => setConfirmation(null)}
						onSubmit={(reason) =>
							confirmation.row
								? manager.reject(confirmation.row, reason)
								: manager.process()
						}
					/>
				)}
			{review &&
				!manager.readBlocked &&
				!manager.writeDenied &&
				!search.invalid && (
					<ChainUnknownReview
						busy={manager.busy}
						disabled={!manager.canRelease && !manager.busy}
						error={manager.error}
						onClose={() => setReview(false)}
						onSubmit={manager.releaseUnknown}
					/>
				)}
		</main>
	)
}

/** A new scope unmounts all financial drafts, dialogs, queries and in-flight requests. */
export function ChainOperationsScreen(props: ChainOperationsScreenProps) {
	const { t } = useTranslation()
	if (
		!props.session.enabled ||
		!props.session.scopeKey ||
		!props.session.subject
	)
		return (
			<main>
				<p role='alert'>{t(prefix + 'accessDenied')}</p>
			</main>
		)
	return (
		<ChainOperationsContent
			key={JSON.stringify([
				props.kind,
				props.session.scopeKey,
				props.session.reconciliationKey,
				props.session.subject,
			])}
			{...props}
		/>
	)
}
