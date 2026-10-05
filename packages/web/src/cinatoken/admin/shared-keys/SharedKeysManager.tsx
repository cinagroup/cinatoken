/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { EarningReview } from './EarningReview'
import { SharedKeyDetailDialog } from './SharedKeyDetailDialog'
import { SharedKeyManualRecovery } from './SharedKeyManualRecovery'
import { SharedKeysTable, type SharedKeyDialogKind } from './SharedKeysTable'
import type {
	AdminSharedKeyOverview,
	AdminSharedKeyRow,
} from './shared-key-contracts'
import { adminSharedKeyRecovery } from './shared-key-recovery'
import type {
	AdminSharedKeysProps,
	useAdminSharedKeys,
} from './use-admin-shared-keys'

const prefix = 'cinatoken.adminSharedKeys.'
export function SharedKeysManager(props: {
	context: AdminSharedKeysProps
	manager: ReturnType<typeof useAdminSharedKeys>
	page: AdminSharedKeyOverview
	onPage: (page: number) => void
}) {
	const { t } = useTranslation()
	const active = useRef(true)
	const [selected, setSelected] = useState<{
		row: AdminSharedKeyRow
		kind: SharedKeyDialogKind
	} | null>(null)
	useEffect(() => {
		active.current = true
		return () => {
			active.current = false
		}
	}, [])
	const pages = Math.max(1, Math.ceil(props.page.total / 20))
	return (
		<section className='space-y-5'>
			<SharedKeyManualRecovery
				api={props.context.api}
				store={adminSharedKeyRecovery(props.context.api).write}
				identity={props.context.reconciliationKey}
				consoleSubject={props.context.consoleSubject}
				enabled={
					props.manager.authorized &&
					!props.manager.deniedAudit &&
					!props.manager.busy
				}
				canReadLogs={props.page.capabilities.request_logs}
				onAccessLost={(stage, status) => {
					if (status === 401 || stage === 'detail')
						props.manager.invalidateRead()
					else if (stage === 'audit') props.manager.invalidateAudit()
					else props.manager.invalidateWrite()
				}}
				onRecovered={() => {
					setSelected(null)
					props.manager.clearNotification()
					void props.manager.query.refetch()
				}}
			/>
			<div className='text-muted-foreground space-y-2 text-xs'>
				<p>{t(prefix + 'legacyPrice')}</p>
				<p>
					{props.page.currentBillingCurrency === null
						? t(prefix + 'referenceUnavailable')
						: t(prefix + 'referenceCurrency', {
								currency: props.page.currentBillingCurrency,
							})}
				</p>
				<p>{t(prefix + 'fixedSort')}</p>
			</div>
			{props.page.items.length === 0 ? (
				<p className='text-muted-foreground rounded-xl border p-8 text-center text-sm'>
					{t(prefix + 'empty')}
				</p>
			) : (
				<SharedKeysTable
					rows={props.page.items}
					capabilities={props.page.capabilities}
					canWrite={props.manager.canWrite}
					onOpen={(row, kind) => {
						props.manager.clearNotification()
						setSelected({ row, kind })
					}}
				/>
			)}
			<nav
				aria-label={t(prefix + 'title')}
				className='flex flex-wrap items-center justify-center gap-3'
			>
				<Button
					type='button'
					variant='outline'
					disabled={
						props.manager.busy ||
						props.manager.query.isFetching ||
						props.page.page <= 1
					}
					onClick={() => props.onPage(props.page.page - 1)}
				>
					{t(prefix + 'previous')}
				</Button>
				<span className='text-sm'>
					{t(prefix + 'page', {
						page: props.page.page,
						pages,
						total: props.page.total,
					})}
				</span>
				<Button
					type='button'
					variant='outline'
					disabled={
						props.manager.busy ||
						props.manager.query.isFetching ||
						!props.page.hasMore ||
						props.page.page >= 1_000_000
					}
					onClick={() => props.onPage(props.page.page + 1)}
				>
					{t(prefix + 'next')}
				</Button>
			</nav>
			{props.page.capabilities.can_review_earnings && (
				<EarningReview
					api={props.context.api}
					scopeKey={props.context.scopeKey}
					reconciliationKey={props.context.reconciliationKey}
					revalidate={props.context.revalidate}
					onReadLost={props.manager.invalidateRead}
					canReadLogs={props.page.capabilities.request_logs}
					consoleSubject={props.context.consoleSubject}
				/>
			)}
			{selected && (
				<SharedKeyDetailDialog
					key={selected.row.id + ':' + selected.kind}
					api={props.context.api}
					scopeKey={props.context.scopeKey}
					row={selected.row}
					kind={selected.kind}
					busy={props.manager.busy}
					canWrite={props.manager.canWrite}
					canReadAudit={!props.manager.deniedAudit}
					error={props.manager.writeError}
					onClose={() => setSelected(null)}
					onReadLost={props.manager.invalidateRead}
					onWriteLost={props.manager.invalidateWrite}
					onAuditLost={props.manager.invalidateAudit}
					onSave={async (row, input) => {
						const deleting = selected.kind === 'delete'
						const outcome = await props.manager.perform(
							{
								kind: 'governance',
								keyId: row.id,
								operation: deleting
									? 'delete'
									: (selected.kind as 'edit' | 'disable' | 'restore'),
							},
							(signal) =>
								deleting
									? props.context.api.deleteAdminSharedKey(row, input.reason, {
											signal,
											expectedConsoleSubject: props.context.consoleSubject,
										})
									: props.context.api.patchAdminSharedKey(row, input, {
											signal,
											expectedConsoleSubject: props.context.consoleSubject,
										})
						)
						if (!active.current) return
						if (outcome === 'saved' && deleting)
							setSelected({ row, kind: 'audit' })
						else if (outcome !== 'rejected') setSelected(null)
					}}
				/>
			)}
		</section>
	)
}
