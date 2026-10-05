/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '../../../components/ui/dialog'
import { Input } from '../../../components/ui/input'
import { Label } from '../../../components/ui/label'
import { AdminDomainRecoveryDialog } from '../AdminDomainRecoveryDialog'
import { AdminGuardrailPreview } from './AdminGuardrailPreview'
import type {
	AdminGuardrailScopeType,
	AdminGuardrailSummary,
} from './guardrails-contracts'
import type { AdminGuardrailPreviewApi } from './preview-api'
import {
	useAdminGuardrailsManager,
	type AdminGuardrailChange,
	type AdminGuardrailsManagerProps,
} from './use-admin-guardrails-manager'

const prefix = 'cinatoken.adminGuardrails.'
const pageSize = 12
const selectClass =
	'bg-background h-10 w-full min-w-0 rounded-md border px-3 text-sm sm:w-auto'

function localDate(value: string, locale: string): string {
	const time = new Date(value)
	return Number.isNaN(time.getTime()) ? '—' : time.toLocaleString(locale)
}

function GuardrailCard(props: {
	row: AdminGuardrailSummary
	canWrite: boolean
	onDetails: () => void
	onChange: (change: AdminGuardrailChange) => void
}) {
	const { t } = useTranslation()
	const row = props.row
	const canArchive =
		props.canWrite && !row.isWorkspaceDefault && !row.isAccountDefault
	return (
		<article className='bg-card min-w-0 space-y-4 rounded-xl border p-4 shadow-sm sm:p-5'>
			<div className='flex min-w-0 flex-wrap items-start justify-between gap-3'>
				<div className='min-w-0'>
					<h2 className='font-semibold break-words'>{row.name}</h2>
					<p className='text-muted-foreground text-xs break-all'>{row.id}</p>
				</div>
				<div className='flex flex-wrap gap-1 text-xs'>
					<span className='bg-muted rounded-full px-2 py-1'>
						{t(prefix + row.status)}
					</span>
					{row.isWorkspaceDefault ? (
						<span className='bg-muted rounded-full px-2 py-1'>
							{t(prefix + 'workspaceDefault')}
						</span>
					) : null}
					{row.isAccountDefault ? (
						<span className='bg-muted rounded-full px-2 py-1'>
							{t(prefix + 'accountDefault')}
						</span>
					) : null}
				</div>
			</div>
			{row.description ? (
				<p className='text-muted-foreground text-sm break-words'>
					{row.description}
				</p>
			) : null}
			<dl className='grid min-w-0 gap-x-3 gap-y-2 text-sm sm:grid-cols-2'>
				<dt className='text-muted-foreground'>{t(prefix + 'workspace')}</dt>
				<dd className='break-all'>{row.workspaceId}</dd>
				<dt className='text-muted-foreground'>{t(prefix + 'owner')}</dt>
				<dd className='break-all'>{row.ownerUserId}</dd>
				<dt className='text-muted-foreground'>{t(prefix + 'designated')}</dt>
				<dd>v{row.designatedVersion}</dd>
				<dt className='text-muted-foreground'>{t(prefix + 'latest')}</dt>
				<dd>v{row.latestVersion}</dd>
			</dl>
			<div className='flex flex-wrap gap-2'>
				<Button
					type='button'
					variant='outline'
					aria-label={`${t(prefix + 'details')}: ${row.workspaceId} / ${row.name}`}
					onClick={props.onDetails}
				>
					{t(prefix + 'details')}
				</Button>
				{canArchive ? (
					<Button
						type='button'
						variant='outline'
						aria-label={`${t(prefix + (row.status === 'active' ? 'archive' : 'restore'))}: ${row.workspaceId} / ${row.name}`}
						onClick={() =>
							props.onChange({
								kind: row.status === 'active' ? 'archive' : 'restore',
							})
						}
					>
						{t(prefix + (row.status === 'active' ? 'archive' : 'restore'))}
					</Button>
				) : null}
			</div>
		</article>
	)
}

function DetailsDialog(props: {
	row: AdminGuardrailSummary
	manager: ReturnType<typeof useAdminGuardrailsManager>
	language: string
}) {
	const { t } = useTranslation()
	const [scopeType, setScopeType] = useState<AdminGuardrailScopeType>('user')
	const [scopeId, setScopeId] = useState('')
	const title = useRef<HTMLHeadingElement>(null)
	const row = props.row
	const manager = props.manager
	const versions = manager.details.data?.versions ?? []
	const assignments = manager.details.data?.assignments ?? []
	const defaultRule = row.isWorkspaceDefault || row.isAccountDefault
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) manager.close()
			}}
		>
			<DialogContent
				className='max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl'
				showCloseButton={false}
				initialFocus={title}
			>
				<DialogHeader>
					<DialogTitle ref={title} tabIndex={-1}>
						{t(prefix + 'detailsTitle', { name: row.name })}
					</DialogTitle>
					<DialogDescription className='break-all'>
						{t(prefix + 'workspace')}: {row.workspaceId} · {t(prefix + 'owner')}
						: {row.ownerUserId}
					</DialogDescription>
				</DialogHeader>
				{manager.details.isPending || manager.details.isFetching ? (
					<p role='status'>{t(prefix + 'loading')}</p>
				) : null}
				{manager.details.error ? (
					<div role='alert' className='space-y-2'>
						<p className='text-destructive text-sm'>
							{t(manager.errorKey(manager.details.error))}
						</p>
						<Button
							variant='outline'
							type='button'
							onClick={() => void manager.details.refetch()}
						>
							{t(prefix + 'retry')}
						</Button>
					</div>
				) : null}
				{!manager.details.error &&
				!manager.details.isFetching &&
				manager.details.data ? (
					<div className='space-y-6'>
						<section className='space-y-3'>
							<h3 className='font-medium'>{t(prefix + 'versions')}</h3>
							{[...versions]
								.sort((a, b) => b.version - a.version)
								.map((version) => (
									<div
										key={version.id}
										className='flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm'
									>
										<div>
											<p className='flex flex-wrap items-center gap-2'>
												v{version.version}
												{version.version === row.designatedVersion ? (
													<span className='bg-muted rounded-full px-2 py-1 text-xs'>
														{t(prefix + 'designatedBadge')}
													</span>
												) : null}
											</p>
											<p className='text-muted-foreground text-xs'>
												{t(prefix + 'created')}:{' '}
												{localDate(version.createdAt, props.language)}
											</p>
										</div>
										{manager.disabled ||
										row.status !== 'active' ||
										version.version === row.designatedVersion ? null : (
											<Button
												type='button'
												variant='outline'
												onClick={() =>
													manager.stage(row, {
														kind: 'designate',
														version: version.version,
													})
												}
											>
												{t(prefix + 'selectVersion')}
											</Button>
										)}
									</div>
								))}
						</section>
						<section className='space-y-3 border-t pt-4'>
							<h3 className='font-medium'>{t(prefix + 'assignments')}</h3>
							{defaultRule ? (
								<p className='text-muted-foreground text-sm'>
									{t(prefix + 'implicitDefault')}
								</p>
							) : (
								<>
									{!manager.disabled && row.status === 'active' ? (
										<div className='grid gap-2 rounded-lg border p-3 sm:grid-cols-[9rem_minmax(0,1fr)_auto] sm:items-end'>
											<div className='space-y-1'>
												<Label htmlFor='guardrail-scope-type'>
													{t(prefix + 'scopeType')}
												</Label>
												<select
													id='guardrail-scope-type'
													className={selectClass}
													value={scopeType}
													onChange={(event) =>
														setScopeType(
															event.target.value as AdminGuardrailScopeType
														)
													}
												>
													<option value='user'>user</option>
													<option value='api_key'>api_key</option>
												</select>
											</div>
											<div className='space-y-1'>
												<Label htmlFor='guardrail-scope-id'>
													{t(prefix + 'scopeId')}
												</Label>
												<Input
													id='guardrail-scope-id'
													value={scopeId}
													onChange={(event) => setScopeId(event.target.value)}
												/>
											</div>
											<Button
												type='button'
												disabled={!scopeId.trim()}
												onClick={() =>
													manager.stage(row, {
														kind: 'bind',
														scopeType,
														scopeId: scopeId.trim(),
													})
												}
											>
												{t(prefix + 'bind')}
											</Button>
										</div>
									) : null}
									{assignments.length === 0 ? (
										<p className='text-muted-foreground text-sm'>
											{t(prefix + 'noAssignments')}
										</p>
									) : null}
									{assignments.map((assignment) => (
										<div
											key={assignment.id}
											className='flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm'
										>
											<code className='break-all'>
												{assignment.scopeType}:{assignment.scopeId}
											</code>
											{!manager.disabled ? (
												<Button
													type='button'
													variant='outline'
													onClick={() =>
														manager.stage(row, { kind: 'unbind', assignment })
													}
												>
													{t(prefix + 'unbind')}
												</Button>
											) : null}
										</div>
									))}
								</>
							)}
						</section>
					</div>
				) : null}
				<Button type='button' variant='outline' onClick={manager.close}>
					{t(prefix + 'close')}
				</Button>
			</DialogContent>
		</Dialog>
	)
}

function changeDescription(
	change: AdminGuardrailChange,
	t: (key: string) => string
): string {
	if (change.kind === 'designate')
		return `${t(prefix + 'designated')}: v${change.version}`
	if (change.kind === 'bind' || change.kind === 'unbind') {
		const scope = change.kind === 'bind' ? change : change.assignment
		return `${t(prefix + change.kind)} · ${scope.scopeType}:${scope.scopeId}`
	}
	return t(prefix + change.kind)
}

export function AdminGuardrails(
	props: AdminGuardrailsManagerProps & { previewApi: AdminGuardrailPreviewApi }
) {
	const { t, i18n } = useTranslation()
	const manager = useAdminGuardrailsManager(props)
	const [search, setSearch] = useState('')
	const [status, setStatus] = useState('')
	const [page, setPage] = useState(0)
	const confirmTitle = useRef<HTMLHeadingElement>(null)
	const scope = JSON.stringify([
		props.scopeKey,
		props.reconciliationKey,
		props.subject,
		props.userId,
		props.canWrite,
	])
	const [previousScope, setPreviousScope] = useState(scope)
	if (previousScope !== scope) {
		setPreviousScope(scope)
		setSearch('')
		setStatus('')
		setPage(0)
	}
	const filtered = useMemo(() => {
		const needle = search.trim().toLocaleLowerCase()
		return manager.rows.filter(
			(row) =>
				(!status || row.status === status) &&
				(!needle ||
					[row.name, row.workspaceId, row.ownerUserId, row.id].some((value) =>
						value.toLocaleLowerCase().includes(needle)
					))
		)
	}, [manager.rows, search, status])
	const pages = Math.max(1, Math.ceil(filtered.length / pageSize))
	const currentPage = Math.min(page, pages - 1)
	const shown = filtered.slice(
		currentPage * pageSize,
		(currentPage + 1) * pageSize
	)
	const panel = manager.panel
	return (
		<main className='mx-auto w-full max-w-6xl min-w-0 space-y-6 px-4 py-6 sm:px-6'>
			<header className='space-y-2'>
				<h1 className='text-2xl font-semibold tracking-tight sm:text-3xl'>
					{t(prefix + 'title')}
				</h1>
				<p className='text-muted-foreground text-sm'>
					{t(prefix + 'subtitle')}
				</p>
			</header>
			<AdminGuardrailPreview
				key={scope}
				api={props.previewApi}
				scopeKey={scope}
				canRead={!manager.revoked}
				readOptions={manager.readOptions}
				onReadFailure={manager.invalidateAccess}
			/>
			<div className='flex flex-wrap items-center justify-between gap-3'>
				<p className='text-muted-foreground text-sm'>
					{t(prefix + 'count', {
						shown: filtered.length,
						total: manager.hidden ? 0 : (manager.list.data?.rows.length ?? 0),
					})}
				</p>
				<Button
					type='button'
					variant='outline'
					onClick={() => void manager.retry()}
				>
					{t(prefix + (manager.revoked ? 'verifyAccess' : 'refresh'))}
				</Button>
			</div>
			{!manager.hidden && !manager.canWrite ? (
				<p className='rounded-lg border p-3 text-sm'>
					{t(prefix + 'readonly')}
				</p>
			) : null}
			{manager.revoked ? (
				<p
					role='alert'
					className='text-destructive rounded-lg border p-3 text-sm'
				>
					{t(manager.errorKey(manager.error))}
				</p>
			) : null}
			<AdminDomainRecoveryDialog
				recovery={manager.manualRecovery}
				busy={manager.saving}
			/>
			{manager.notice ? (
				<p role='status' className='rounded-lg border p-3 text-sm'>
					{t(prefix + 'saved')}
				</p>
			) : null}
			{manager.list.error && !manager.revoked ? (
				<p
					role='alert'
					className='text-destructive rounded-lg border p-3 text-sm'
				>
					{t(manager.errorKey(manager.list.error))}
				</p>
			) : null}
			{manager.details.error && !manager.revoked ? (
				<p
					role='alert'
					className='text-destructive rounded-lg border p-3 text-sm'
				>
					{t(manager.errorKey(manager.details.error))}
				</p>
			) : null}
			{manager.reconciliationError && !manager.revoked ? (
				<p role='alert' className='text-destructive text-sm'>
					{t(manager.errorKey(manager.reconciliationError))}
				</p>
			) : null}
			{manager.error && !manager.revoked && !manager.writeUnconfirmed ? (
				<p role='alert' className='text-destructive text-sm'>
					{t(manager.errorKey(manager.error))}
				</p>
			) : null}
			<div className='flex flex-wrap gap-2'>
				<Input
					className='min-w-0 flex-1 basis-56'
					aria-label={t(prefix + 'search')}
					placeholder={t(prefix + 'search')}
					value={search}
					onChange={(event) => {
						setSearch(event.target.value)
						setPage(0)
					}}
				/>
				<select
					className={selectClass}
					aria-label={t(prefix + 'allStatuses')}
					value={status}
					onChange={(event) => {
						setStatus(event.target.value)
						setPage(0)
					}}
				>
					<option value=''>{t(prefix + 'allStatuses')}</option>
					<option value='active'>{t(prefix + 'active')}</option>
					<option value='archived'>{t(prefix + 'archived')}</option>
				</select>
			</div>
			{manager.list.isPending && !manager.list.error ? (
				<p role='status' className='text-muted-foreground text-sm'>
					{t(prefix + 'loading')}
				</p>
			) : null}
			{!manager.hidden && manager.list.data?.rows.length === 0 ? (
				<p className='rounded-xl border border-dashed p-8 text-center text-sm'>
					{t(prefix + 'empty')}
				</p>
			) : null}
			{!manager.hidden &&
			manager.list.data &&
			manager.list.data.rows.length > 0 &&
			filtered.length === 0 ? (
				<p className='rounded-xl border border-dashed p-8 text-center text-sm'>
					{t(prefix + 'noMatches')}
				</p>
			) : null}
			<div className='grid min-w-0 gap-4 lg:grid-cols-2'>
				{shown.map((row) => (
					<GuardrailCard
						key={row.id}
						row={row}
						canWrite={!manager.disabled}
						onDetails={() => manager.openDetails(row)}
						onChange={(change) => manager.stage(row, change)}
					/>
				))}
			</div>
			{filtered.length > pageSize ? (
				<div className='flex flex-wrap items-center justify-between gap-3'>
					<p className='text-muted-foreground text-xs'>
						{t(prefix + 'page', { page: currentPage + 1, pages })}
					</p>
					<div className='flex gap-2'>
						<Button
							type='button'
							variant='outline'
							disabled={currentPage === 0}
							onClick={() => setPage(currentPage - 1)}
						>
							{t(prefix + 'previous')}
						</Button>
						<Button
							type='button'
							variant='outline'
							disabled={currentPage + 1 >= pages}
							onClick={() => setPage(currentPage + 1)}
						>
							{t(prefix + 'next')}
						</Button>
					</div>
				</div>
			) : null}
			{panel?.kind === 'details' ? (
				<DetailsDialog
					key={panel.row.id}
					row={panel.row}
					manager={manager}
					language={i18n.resolvedLanguage ?? 'en'}
				/>
			) : null}
			{panel?.kind === 'confirm' ? (
				<Dialog
					open
					onOpenChange={(open) => {
						if (!open) manager.close()
					}}
				>
					<DialogContent
						className='max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg'
						showCloseButton={false}
						initialFocus={confirmTitle}
					>
						<DialogHeader>
							<DialogTitle ref={confirmTitle} tabIndex={-1}>
								{t(prefix + 'confirmTitle')}
							</DialogTitle>
							<DialogDescription>{t(prefix + 'confirmHint')}</DialogDescription>
						</DialogHeader>
						<dl className='grid gap-2 text-sm'>
							<dt className='text-muted-foreground'>
								{t(prefix + 'workspace')}
							</dt>
							<dd className='break-all'>{panel.row.workspaceId}</dd>
							<dt className='text-muted-foreground'>{t(prefix + 'owner')}</dt>
							<dd className='break-all'>{panel.row.ownerUserId}</dd>
							<dt className='text-muted-foreground'>{t(prefix + 'name')}</dt>
							<dd className='break-words'>{panel.row.name}</dd>
							<dt className='text-muted-foreground'>{t(prefix + 'status')}</dt>
							<dd className='break-all'>
								{changeDescription(panel.change, t)}
							</dd>
						</dl>
						{panel.change.kind === 'bind' ? (
							<p className='rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm'>
								{t(prefix + 'bindWarning')}
							</p>
						) : null}
						{manager.error ? (
							<p role='alert' className='text-destructive text-sm'>
								{t(manager.errorKey(manager.error))}
							</p>
						) : null}
						<DialogFooter>
							<Button
								type='button'
								variant='outline'
								disabled={manager.saving}
								onClick={manager.close}
							>
								{t(prefix + 'cancel')}
							</Button>
							<Button
								type='button'
								onClick={() => void manager.confirm()}
								disabled={manager.disabled}
							>
								{t(prefix + 'confirmAction')}
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			) : null}
		</main>
	)
}
