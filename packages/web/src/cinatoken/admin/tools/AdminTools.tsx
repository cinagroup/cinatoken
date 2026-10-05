/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import { ToolDetailDialog } from './ToolDetailDialog'
import { ToolsAuditDialog } from './ToolsAuditDialog'
import { ToolsFamilySection } from './ToolsFamilySection'
import { ToolsManualRecovery } from './ToolsManualRecovery'
import type { ToolOverview } from './tools-contracts'
import { toolsPrefix, type ToolFamily, type ToolProvider } from './tools-domain'
import { toolErrorKey } from './tools-errors'
import {
	useAdminTools,
	type AdminToolsProps,
	type ToolsManager,
} from './use-admin-tools'

export function AdminTools(props: AdminToolsProps) {
	return (
		<ToolsSession
			key={JSON.stringify([
				props.scopeKey,
				props.reconciliationKey,
				props.canWrite,
				props.consoleSubject,
			])}
			{...props}
		/>
	)
}
function ToolsSession(props: AdminToolsProps) {
	const { t } = useTranslation(),
		manager = useAdminTools(props)
	let content
	if (manager.blocked)
		content = (
			<p role='alert' className='rounded-xl border p-5'>
				{t(toolsPrefix + 'accessDenied')}
			</p>
		)
	else if (manager.query.error)
		content = (
			<p role='alert' className='rounded-xl border p-5'>
				{t(toolsPrefix + toolErrorKey(manager.query.error))}
			</p>
		)
	else if (manager.query.data)
		content = (
			<ToolsContent
				key={JSON.stringify([
					props.scopeKey,
					props.reconciliationKey,
					props.canWrite,
					manager.deniedWrite,
					manager.deniedReveal,
					manager.deniedAudit,
					manager.query.data.capabilities,
				])}
				context={props}
				manager={manager}
				page={manager.query.data}
			/>
		)
	else content = <p role='status'>{t(toolsPrefix + 'loading')}</p>
	return (
		<main className='min-w-0 space-y-5 pb-10'>
			<header className='flex flex-wrap items-start justify-between gap-3'>
				<div>
					<h1 className='text-2xl font-semibold'>
						{t(toolsPrefix + 'pageTitle')}
					</h1>
					<p className='text-muted-foreground mt-1 text-sm'>
						{t(toolsPrefix + 'pageHelp')}
					</p>
				</div>
				<Button
					type='button'
					variant='outline'
					disabled={manager.blocked || manager.query.isFetching || manager.busy}
					onClick={() => void manager.query.refetch()}
				>
					{t(toolsPrefix + 'refresh')}
				</Button>
			</header>
			{manager.writeStatus !== 'ready' && (
				<p
					role='alert'
					className='rounded-xl border border-amber-500/50 p-4 text-sm'
				>
					{t(
						toolsPrefix +
							(manager.writeStatus === 'pending'
								? 'pending'
								: 'storageUnavailable')
					)}
				</p>
			)}
			{manager.error && (
				<p role='alert' className='text-destructive rounded-xl border p-4'>
					{t(toolsPrefix + manager.error)}
				</p>
			)}
			{manager.saved && <p role='status'>{t(toolsPrefix + 'saved')}</p>}
			{content}
		</main>
	)
}
function ToolsContent(props: {
	context: AdminToolsProps
	manager: ToolsManager
	page: ToolOverview
}) {
	const accessLost = props.manager.accessLost
	const auditLost = useCallback(
		(error: unknown) => accessLost('audit', error),
		[accessLost]
	)
	const { t } = useTranslation(),
		[editing, setEditing] = useState<{
			family: ToolFamily
			provider: ToolProvider
		} | null>(null),
		[audit, setAudit] = useState<ToolFamily | null>(null),
		[recoveryEpoch, setRecoveryEpoch] = useState(0)
	useEffect(() => {
		const clear = () => {
			setEditing(null)
			setAudit(null)
			setRecoveryEpoch((value) => value + 1)
		}
		window.addEventListener('pagehide', clear)
		const hidden = () => {
			if (document.visibilityState === 'hidden') clear()
		}
		document.addEventListener('visibilitychange', hidden)
		return () => {
			window.removeEventListener('pagehide', clear)
			document.removeEventListener('visibilitychange', hidden)
		}
	}, [])
	function recovered() {
		setEditing(null)
		setAudit(null)
		setRecoveryEpoch((value) => value + 1)
		void props.manager.query.refetch()
	}
	return (
		<div className='space-y-5'>
			{!props.context.canWrite ||
			props.manager.deniedWrite ||
			!props.page.capabilities.can_write ? (
				<p className='text-sm'>{t(toolsPrefix + 'readOnly')}</p>
			) : null}
			<ToolsManualRecovery
				key={recoveryEpoch}
				context={props.context}
				manager={props.manager}
				onRecovered={recovered}
			/>
			{props.page.families.map((state) => (
				<ToolsFamilySection
					key={state.family}
					state={state}
					currency={props.page.billingCurrency}
					capabilities={props.page.capabilities}
					canEdit={
						props.manager.writeStatus === 'ready' &&
						!props.manager.busy &&
						!props.manager.query.isFetching
					}
					canAudit={!props.manager.deniedAudit}
					busy={props.manager.busy}
					onEdit={(provider) => setEditing({ family: state.family, provider })}
					onAudit={() => setAudit(state.family)}
				/>
			))}
			{editing && (
				<ToolDetailDialog
					context={props.context}
					manager={props.manager}
					family={editing.family}
					provider={editing.provider}
					onClose={() => setEditing(null)}
				/>
			)}
			{audit && (
				<ToolsAuditDialog
					api={props.context.api}
					family={audit}
					onClose={() => setAudit(null)}
					onAccessLost={auditLost}
				/>
			)}
		</div>
	)
}
