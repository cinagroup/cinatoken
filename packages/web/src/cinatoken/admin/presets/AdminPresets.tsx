/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useMemo, useRef, useState, type FormEvent } from 'react'
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
import { Textarea } from '../../../components/ui/textarea'
import { AdminDomainRecoveryDialog } from '../AdminDomainRecoveryDialog'
import type {
	AdminPresetMetadataPatch,
	AdminPresetSummary,
} from './presets-contracts'
import {
	useAdminPresetsManager,
	type AdminPresetChange,
	type AdminPresetsManagerProps,
} from './use-admin-presets-manager'

const prefix = 'cinatoken.adminPresets.'
const pageSize = 12
const selectClass =
	'bg-background h-10 w-full min-w-0 rounded-md border px-3 text-sm sm:w-auto'

function localDate(value: string, locale: string): string {
	const time = new Date(value)
	return Number.isNaN(time.getTime()) ? '—' : time.toLocaleString(locale)
}

function PresetCard(props: {
	row: AdminPresetSummary
	canWrite: boolean
	onVersions: () => void
	onEdit: () => void
	onChange: (change: AdminPresetChange) => void
}) {
	const { t } = useTranslation()
	const row = props.row
	return (
		<article className='bg-card min-w-0 space-y-4 rounded-xl border p-4 shadow-sm sm:p-5'>
			<div className='flex min-w-0 flex-wrap items-start justify-between gap-3'>
				<div className='min-w-0'>
					<h2 className='font-semibold break-words'>{row.name}</h2>
					<p className='text-muted-foreground text-sm break-all'>{row.slug}</p>
				</div>
				<div className='flex flex-wrap gap-1 text-xs'>
					<span className='bg-muted rounded-full px-2 py-1'>
						{t(prefix + row.status)}
					</span>
					<span className='bg-muted rounded-full px-2 py-1'>
						{t(prefix + row.visibility)}
					</span>
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
					aria-label={`${t(prefix + 'versions')}: ${row.workspaceId} / ${row.slug}`}
					onClick={props.onVersions}
				>
					{t(prefix + 'versions')}
				</Button>
				{props.canWrite ? (
					<>
						<Button
							type='button'
							variant='outline'
							aria-label={`${t(prefix + 'edit')}: ${row.workspaceId} / ${row.slug}`}
							onClick={props.onEdit}
						>
							{t(prefix + 'edit')}
						</Button>
						<Button
							type='button'
							variant='outline'
							aria-label={`${t(prefix + (row.visibility === 'public' ? 'makePrivate' : 'makePublic'))}: ${row.workspaceId} / ${row.slug}`}
							onClick={() =>
								props.onChange({
									kind: row.visibility === 'public' ? 'private' : 'public',
								})
							}
						>
							{t(
								prefix +
									(row.visibility === 'public' ? 'makePrivate' : 'makePublic')
							)}
						</Button>
						<Button
							type='button'
							variant='outline'
							aria-label={`${t(prefix + (row.status === 'active' ? 'archive' : 'restore'))}: ${row.workspaceId} / ${row.slug}`}
							onClick={() =>
								props.onChange({
									kind: row.status === 'active' ? 'archive' : 'restore',
								})
							}
						>
							{t(prefix + (row.status === 'active' ? 'archive' : 'restore'))}
						</Button>
					</>
				) : null}
			</div>
		</article>
	)
}

function MetadataDialog(props: {
	row: AdminPresetSummary
	onSave: (patch: AdminPresetMetadataPatch) => void
	onClose: () => void
}) {
	const { t } = useTranslation()
	const title = useRef<HTMLHeadingElement>(null)
	const [name, setName] = useState(props.row.name)
	const [description, setDescription] = useState(props.row.description ?? '')
	const [visibility, setVisibility] = useState<'private' | 'public'>(
		props.row.visibility
	)
	const [validation, setValidation] = useState<string | null>(null)
	const changed =
		name !== props.row.name ||
		description !== (props.row.description ?? '') ||
		visibility !== props.row.visibility
	function submit(event: FormEvent<HTMLFormElement>): void {
		event.preventDefault()
		const cleanName = name.trim()
		const cleanDescription = description.trim()
		if (name !== props.row.name && (!cleanName || cleanName.length > 128))
			return setValidation('nameRequired')
		if (
			description !== (props.row.description ?? '') &&
			cleanDescription.length > 1024
		)
			return setValidation('descriptionTooLong')
		setValidation(null)
		const patch: AdminPresetMetadataPatch = {}
		if (name !== props.row.name) patch.name = cleanName
		if (description !== (props.row.description ?? ''))
			patch.description = cleanDescription || null
		if (visibility !== props.row.visibility) patch.visibility = visibility
		if (!Object.keys(patch).length) return
		props.onSave(patch)
	}
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) props.onClose()
			}}
		>
			<DialogContent
				initialFocus={title}
				className='max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg'
				showCloseButton={false}
			>
				<DialogHeader>
					<DialogTitle ref={title} tabIndex={-1}>
						{t(prefix + 'metadataTitle', { name: props.row.name })}
					</DialogTitle>
					<DialogDescription>{t(prefix + 'scopeHint')}</DialogDescription>
				</DialogHeader>
				<form className='space-y-4' onSubmit={submit}>
					<p className='text-muted-foreground text-xs break-all'>
						{t(prefix + 'workspace')}: {props.row.workspaceId} ·{' '}
						{t(prefix + 'owner')}: {props.row.ownerUserId}
					</p>
					<div className='space-y-2'>
						<Label htmlFor='admin-preset-name'>{t(prefix + 'name')}</Label>
						<Input
							id='admin-preset-name'
							maxLength={128}
							value={name}
							onChange={(event) => setName(event.target.value)}
						/>
					</div>
					<div className='space-y-2'>
						<Label htmlFor='admin-preset-description'>
							{t(prefix + 'description')}
						</Label>
						<Textarea
							id='admin-preset-description'
							rows={4}
							maxLength={1024}
							value={description}
							onChange={(event) => setDescription(event.target.value)}
						/>
					</div>
					<div className='space-y-2'>
						<Label htmlFor='admin-preset-visibility'>
							{t(prefix + 'visibility')}
						</Label>
						<select
							id='admin-preset-visibility'
							className={selectClass}
							value={visibility}
							onChange={(event) =>
								setVisibility(event.target.value as 'private' | 'public')
							}
						>
							<option value='private'>{t(prefix + 'private')}</option>
							<option value='public'>{t(prefix + 'public')}</option>
						</select>
					</div>
					{validation ? (
						<p role='alert' className='text-destructive text-sm'>
							{t(prefix + validation)}
						</p>
					) : null}
					<DialogFooter>
						<Button type='button' variant='outline' onClick={props.onClose}>
							{t(prefix + 'cancel')}
						</Button>
						<Button type='submit' disabled={!changed}>
							{t(prefix + 'save')}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}

function changeDescription(
	change: AdminPresetChange,
	t: (key: string) => string
): string {
	if (change.kind === 'metadata') return t(prefix + 'edit')
	if (change.kind === 'designate')
		return `${t(prefix + 'designated')}: v${change.version}`
	if (change.kind === 'public') return t(prefix + 'makePublic')
	if (change.kind === 'private') return t(prefix + 'makePrivate')
	return t(prefix + change.kind)
}

export function AdminPresets(props: AdminPresetsManagerProps) {
	const { t, i18n } = useTranslation()
	const title = useRef<HTMLHeadingElement>(null)
	const manager = useAdminPresetsManager(props)
	const [search, setSearch] = useState('')
	const [status, setStatus] = useState('')
	const [visibility, setVisibility] = useState('')
	const [page, setPage] = useState(0)
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
		setVisibility('')
		setPage(0)
	}
	const filtered = useMemo(() => {
		const needle = search.trim().toLocaleLowerCase()
		return manager.rows.filter(
			(row) =>
				(!status || row.status === status) &&
				(!visibility || row.visibility === visibility) &&
				(!needle ||
					[row.name, row.slug, row.workspaceId, row.ownerUserId].some((value) =>
						value.toLocaleLowerCase().includes(needle)
					))
		)
	}, [manager.rows, search, status, visibility])
	const pages = Math.max(1, Math.ceil(filtered.length / pageSize))
	const currentPage = Math.min(page, pages - 1)
	const shown = filtered.slice(
		currentPage * pageSize,
		(currentPage + 1) * pageSize
	)
	const panel = manager.panel
	const versions = manager.versions
	function filterChange(next: {
		search?: string
		status?: string
		visibility?: string
	}): void {
		if (next.search !== undefined) setSearch(next.search)
		if (next.status !== undefined) setStatus(next.status)
		if (next.visibility !== undefined) setVisibility(next.visibility)
		setPage(0)
	}
	return (
		<main className='mx-auto w-full max-w-6xl min-w-0 space-y-6 px-4 py-6 sm:px-6'>
			<header className='space-y-2'>
				<h1 className='text-2xl font-semibold tracking-tight sm:text-3xl'>
					{t(prefix + 'title')}
				</h1>
				<p className='text-muted-foreground text-sm'>
					{t(prefix + 'subtitle')}
				</p>
				<p className='text-muted-foreground text-xs'>
					{t(prefix + 'scopeHint')}
				</p>
			</header>
			<div className='flex flex-wrap items-center justify-between gap-3'>
				<p className='text-muted-foreground text-sm'>
					{t(prefix + 'count', {
						shown: filtered.length,
						total: manager.hidden ? 0 : (manager.list.data?.length ?? 0),
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
			{!props.canWrite ? (
				<p className='rounded-lg border p-3 text-sm'>
					{t(prefix + 'readonly')}
				</p>
			) : null}
			{manager.revoked ? (
				<p
					role='alert'
					className='text-destructive rounded-lg border p-3 text-sm'
				>
					{t(manager.errorKey(manager.reconciliationError))}
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
			{manager.reconciliationError && !manager.revoked ? (
				<p role='alert' className='text-destructive text-sm'>
					{t(manager.errorKey(manager.reconciliationError))}
				</p>
			) : null}
			<div className='flex flex-col gap-3 sm:flex-row sm:flex-wrap'>
				<Input
					className='sm:min-w-64 sm:flex-1'
					aria-label={t(prefix + 'search')}
					placeholder={t(prefix + 'search')}
					value={search}
					onChange={(event) => filterChange({ search: event.target.value })}
				/>
				<select
					className={selectClass}
					aria-label={t(prefix + 'allStatuses')}
					value={status}
					onChange={(event) => filterChange({ status: event.target.value })}
				>
					<option value=''>{t(prefix + 'allStatuses')}</option>
					<option value='active'>{t(prefix + 'active')}</option>
					<option value='archived'>{t(prefix + 'archived')}</option>
				</select>
				<select
					className={selectClass}
					aria-label={t(prefix + 'allVisibilities')}
					value={visibility}
					onChange={(event) => filterChange({ visibility: event.target.value })}
				>
					<option value=''>{t(prefix + 'allVisibilities')}</option>
					<option value='private'>{t(prefix + 'private')}</option>
					<option value='public'>{t(prefix + 'public')}</option>
				</select>
			</div>
			{manager.list.isPending && !manager.list.error ? (
				<p role='status' className='text-muted-foreground text-sm'>
					{t(prefix + 'loading')}
				</p>
			) : null}
			{!manager.hidden && manager.list.data?.length === 0 ? (
				<p className='rounded-xl border border-dashed p-8 text-center text-sm'>
					{t(prefix + 'empty')}
				</p>
			) : null}
			{!manager.hidden &&
			manager.list.data &&
			manager.list.data.length > 0 &&
			filtered.length === 0 ? (
				<p className='rounded-xl border border-dashed p-8 text-center text-sm'>
					{t(prefix + 'noMatches')}
				</p>
			) : null}
			<div className='grid min-w-0 gap-4 lg:grid-cols-2'>
				{shown.map((row) => (
					<PresetCard
						key={row.id}
						row={row}
						canWrite={!manager.disabled}
						onVersions={() => manager.openVersions(row)}
						onEdit={() => manager.openMetadata(row)}
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
			{panel?.kind === 'metadata' ? (
				<MetadataDialog
					key={panel.row.id}
					row={panel.row}
					onClose={manager.close}
					onSave={(patch) =>
						manager.stage(panel.row, { kind: 'metadata', patch })
					}
				/>
			) : null}
			{panel?.kind === 'versions' ? (
				<Dialog
					open
					onOpenChange={(open) => {
						if (!open) manager.close()
					}}
				>
					<DialogContent
						initialFocus={title}
						className='max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl'
						showCloseButton={false}
					>
						<DialogHeader>
							<DialogTitle ref={title} tabIndex={-1}>
								{t(prefix + 'versionsTitle', { name: panel.row.name })}
							</DialogTitle>
							<DialogDescription className='break-all'>
								{t(prefix + 'workspace')}: {panel.row.workspaceId} ·{' '}
								{t(prefix + 'slug')}: {panel.row.slug}
							</DialogDescription>
						</DialogHeader>
						{versions.isPending || versions.isFetching ? (
							<p role='status'>{t(prefix + 'loading')}</p>
						) : null}
						{versions.error ? (
							<div role='alert' className='space-y-2'>
								<p className='text-destructive text-sm'>
									{t(manager.errorKey(versions.error))}
								</p>
								<Button
									type='button'
									variant='outline'
									onClick={() => void versions.refetch()}
								>
									{t(prefix + 'retry')}
								</Button>
							</div>
						) : null}
						{!versions.error && !versions.isFetching && versions.data ? (
							<div className='space-y-3'>
								{versions.data.length === 0 ? (
									<p className='text-muted-foreground text-sm'>
										{t(prefix + 'notSet')}
									</p>
								) : null}
								{[...versions.data]
									.sort((a, b) => b.version - a.version)
									.map((version) => (
										<article key={version.id} className='rounded-lg border p-4'>
											<div className='flex flex-wrap items-center gap-2'>
												<h3 className='font-medium'>v{version.version}</h3>
												{version.version === panel.row.designatedVersion ? (
													<span className='bg-muted rounded-full px-2 py-1 text-xs'>
														{t(prefix + 'designatedBadge')}
													</span>
												) : null}
												{version.version === panel.row.latestVersion ? (
													<span className='bg-muted rounded-full px-2 py-1 text-xs'>
														{t(prefix + 'latestBadge')}
													</span>
												) : null}
											</div>
											<p className='text-muted-foreground mt-2 text-xs break-words'>
												{t(prefix + 'model')}:{' '}
												{version.model ?? t(prefix + 'notSet')}
											</p>
											<p className='text-muted-foreground mt-1 text-xs'>
												{t(prefix + 'created')}:{' '}
												{localDate(
													version.createdAt,
													i18n.resolvedLanguage ?? 'en'
												)}
											</p>
											{props.canWrite &&
											panel.row.status === 'active' &&
											version.version !== panel.row.designatedVersion ? (
												<Button
													className='mt-3'
													type='button'
													disabled={manager.disabled}
													aria-label={`${t(prefix + 'selectVersion')}: ${panel.row.workspaceId} / ${panel.row.slug} / v${version.version}`}
													onClick={() =>
														manager.stage(panel.row, {
															kind: 'designate',
															version: version.version,
														})
													}
												>
													{t(prefix + 'selectVersion')}
												</Button>
											) : null}
										</article>
									))}
							</div>
						) : null}
						<Button type='button' variant='outline' onClick={manager.close}>
							{t(prefix + 'close')}
						</Button>
					</DialogContent>
				</Dialog>
			) : null}
			{panel?.kind === 'confirm' ? (
				<Dialog
					open
					onOpenChange={(open) => {
						if (!open) manager.close()
					}}
				>
					<DialogContent
						initialFocus={title}
						className='max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg'
						showCloseButton={false}
					>
						<DialogHeader>
							<DialogTitle ref={title} tabIndex={-1}>
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
							<dt className='text-muted-foreground'>{t(prefix + 'slug')}</dt>
							<dd className='break-all'>{panel.row.slug}</dd>
							<dt className='text-muted-foreground'>{t(prefix + 'status')}</dt>
							<dd>{changeDescription(panel.change, t)}</dd>
						</dl>
						{panel.change.kind === 'metadata' ? (
							<div className='bg-muted/40 space-y-1 rounded-lg p-3 text-sm'>
								<p>
									{t(prefix + 'name')}:{' '}
									{panel.change.patch.name ?? panel.row.name}
								</p>
								<p className='break-words'>
									{t(prefix + 'description')}:{' '}
									{(panel.change.patch.description === undefined
										? panel.row.description
										: panel.change.patch.description) || t(prefix + 'notSet')}
								</p>
								<p>
									{t(prefix + 'visibility')}:{' '}
									{t(
										prefix +
											(panel.change.patch.visibility ?? panel.row.visibility)
									)}
								</p>
							</div>
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
								disabled={manager.disabled}
								onClick={() => void manager.confirm()}
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
