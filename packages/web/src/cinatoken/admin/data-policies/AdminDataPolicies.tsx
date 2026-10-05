/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import { AdminDomainRecoveryDialog } from '../AdminDomainRecoveryDialog'
import { DataPolicyAuditDialog } from './DataPolicyAuditDialog'
import { DataPolicyEditorDialog } from './DataPolicyEditorDialog'
import type { DataPolicyListRow } from './data-policy-contracts'
import { dataPolicyErrorKey } from './data-policy-errors'
import {
	emptyDataPolicyFilters,
	validateDataPolicySearch,
	type DataPolicyFilters,
} from './data-policy-search'
import { dataPolicySummary, filterDataPolicies } from './data-policy-view'
import {
	useDataPoliciesManager,
	type DataPoliciesManagerProps,
} from './use-data-policies-manager'

const prefix = 'cinatoken.adminDataPolicies.'
const selectClass =
	'bg-background h-10 w-full min-w-0 rounded-md border px-3 text-sm'

export type AdminDataPoliciesProps = DataPoliciesManagerProps & {
	initialFilters?: Partial<DataPolicyFilters>
	onFiltersChange?: (filters: DataPolicyFilters) => void
}

function dateText(value: string | null): string {
	return value ? new Date(value).toLocaleString() : '—'
}

function PolicyCard(props: {
	row: DataPolicyListRow
	canEdit: boolean
	onEdit: () => void
	onAudit: () => void
}) {
	const { t } = useTranslation()
	const row = props.row
	return (
		<article className='bg-card min-w-0 rounded-xl border p-4 shadow-sm sm:p-5'>
			<div className='flex min-w-0 flex-wrap items-start justify-between gap-3'>
				<div className='min-w-0'>
					<h2 className='font-semibold break-words'>
						{row.provider_model_name || row.model_id}
					</h2>
					<p className='text-muted-foreground text-sm break-words'>
						{row.provider_name || row.provider_id}
					</p>
					<p className='text-muted-foreground text-xs break-all'>
						{t(prefix + 'model')}: {row.model_id}
					</p>
				</div>
				<span className='bg-muted rounded-full px-3 py-1 text-xs font-medium'>
					{t(prefix + row.effective_status)}
				</span>
			</div>
			<p className='text-muted-foreground mt-2 text-xs break-all'>
				{t(prefix + 'target')}: {row.route_target_id}
			</p>
			{row.subject_fingerprint === null ? (
				<p className='mt-3 rounded-lg border border-dashed p-2 text-sm'>
					{t(prefix + 'unconfigured')}
				</p>
			) : null}
			{!row.subject_matches_current && row.subject_fingerprint !== null ? (
				<p
					role='alert'
					className='mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-sm'
				>
					{t(prefix + 'subjectChanged')}
				</p>
			) : null}
			{row.invalidation_reason ? (
				<p className='text-muted-foreground mt-2 text-xs break-words'>
					{t(prefix + 'invalidated', { reason: row.invalidation_reason })}
				</p>
			) : null}
			<dl className='mt-4 grid min-w-0 gap-x-3 gap-y-2 text-sm sm:grid-cols-2'>
				<dt className='text-muted-foreground'>{t(prefix + 'storedStatus')}</dt>
				<dd>{t(prefix + row.status)}</dd>
				<dt className='text-muted-foreground'>
					{t(prefix + 'effectiveStatus')}
				</dt>
				<dd>{t(prefix + row.effective_status)}</dd>
				<dt className='text-muted-foreground'>{t(prefix + 'protocol')}</dt>
				<dd className='break-words'>
					{row.upstream_protocol}
					{row.upstream_operation ? ` · ${row.upstream_operation}` : ''}
				</dd>
				<dt className='text-muted-foreground'>{t(prefix + 'group')}</dt>
				<dd className='break-words'>
					{row.route_group || t(prefix + 'notSet')}
				</dd>
				<dt className='text-muted-foreground'>{t(prefix + 'retention')}</dt>
				<dd>{row.retention_days ?? t(prefix + 'notSet')}</dd>
				<dt className='text-muted-foreground'>{t(prefix + 'training')}</dt>
				<dd>{t(prefix + (row.training_allowed ? 'yes' : 'no'))}</dd>
				<dt className='text-muted-foreground'>{t(prefix + 'zdr')}</dt>
				<dd>{t(prefix + (row.zdr_supported ? 'yes' : 'no'))}</dd>
				<dt className='text-muted-foreground'>{t(prefix + 'expiry')}</dt>
				<dd>{dateText(row.expires_at)}</dd>
				<dt className='text-muted-foreground'>{t(prefix + 'updated')}</dt>
				<dd>{dateText(row.updated_at)}</dd>
				<dt className='text-muted-foreground'>{t(prefix + 'evidence')}</dt>
				<dd className='min-w-0 break-all'>
					{row.evidence_url ? (
						<a
							href={row.evidence_url}
							target='_blank'
							rel='noopener noreferrer'
							className='underline underline-offset-2'
						>
							{row.evidence_url}
						</a>
					) : (
						t(prefix + 'notSet')
					)}
				</dd>
			</dl>
			<div className='mt-4 flex flex-wrap gap-2'>
				<Button
					type='button'
					variant='outline'
					aria-label={t(prefix + 'auditTarget', {
						target: row.route_target_id,
					})}
					onClick={props.onAudit}
				>
					{t(prefix + 'audit')}
				</Button>
				{props.canEdit ? (
					<Button
						type='button'
						aria-label={t(prefix + 'editTarget', {
							target: row.route_target_id,
						})}
						onClick={props.onEdit}
					>
						{t(prefix + 'edit')}
					</Button>
				) : null}
			</div>
		</article>
	)
}

export function AdminDataPolicies(props: AdminDataPoliciesProps) {
	return (
		<DataPolicySession
			key={JSON.stringify([
				props.scopeKey,
				props.reconciliationKey,
				props.subject,
				props.userId,
				props.canWrite,
			])}
			{...props}
		/>
	)
}

function DataPolicySession(props: AdminDataPoliciesProps) {
	const { t } = useTranslation()
	const manager = useDataPoliciesManager(props)
	const [localFilters, setLocalFilters] = useState<DataPolicyFilters>(() =>
		validateDataPolicySearch(props.initialFilters ?? emptyDataPolicyFilters)
	)
	const filters = props.onFiltersChange
		? validateDataPolicySearch(props.initialFilters)
		: localFilters
	const shown = useMemo(
		() => filterDataPolicies(manager.rows, filters),
		[manager.rows, filters]
	)
	const summary = useMemo(() => dataPolicySummary(manager.rows), [manager.rows])
	const noMatches = manager.rows.length > 0 && shown.length === 0
	function change(patch: Partial<DataPolicyFilters>): void {
		const next = validateDataPolicySearch({ ...filters, ...patch })
		if (props.onFiltersChange) props.onFiltersChange(next)
		else setLocalFilters(next)
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
					{t(prefix + 'consoleHint')}
				</p>
			</header>
			<div className='flex flex-wrap items-center justify-between gap-3'>
				<p className='text-muted-foreground text-sm'>
					{t(prefix + 'count', summary)}
				</p>
				<Button
					type='button'
					variant='outline'
					onClick={() => void manager.retry()}
				>
					{t(prefix + (manager.hidden ? 'verifyAccess' : 'refresh'))}
				</Button>
			</div>
			{!manager.canWrite ? (
				<p className='rounded-lg border p-3 text-sm'>
					{t(prefix + 'readonly')}
				</p>
			) : null}
			{manager.hidden ? (
				<p
					role='alert'
					className='text-destructive rounded-lg border p-3 text-sm'
				>
					{t(
						manager.blockedError
							? dataPolicyErrorKey(manager.blockedError)
							: prefix + 'accessDenied'
					)}
				</p>
			) : null}
			<AdminDomainRecoveryDialog
				recovery={manager.manualRecovery}
				busy={manager.mutation.isPending}
			/>
			{manager.notice ? (
				<p role='status' className='rounded-lg border p-3 text-sm'>
					{t(prefix + 'saved')}
				</p>
			) : null}
			{manager.reconciliationErrorKey ? (
				<p role='alert' className='text-destructive text-sm'>
					{t(manager.reconciliationErrorKey)}
				</p>
			) : null}
			{manager.list.error && !manager.hidden ? (
				<p
					role='alert'
					className='text-destructive rounded-lg border p-3 text-sm'
				>
					{t(dataPolicyErrorKey(manager.list.error))}
				</p>
			) : null}
			{manager.mutation.error && !manager.panel && !manager.hidden ? (
				<p role='alert' className='text-destructive text-sm'>
					{t(dataPolicyErrorKey(manager.mutation.error))}
				</p>
			) : null}
			<div className='grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(160px,220px)]'>
				<label className='block min-w-0 space-y-1 text-sm'>
					<span>{t(prefix + 'search')}</span>
					<Input
						value={filters.q}
						onChange={(event) => change({ q: event.target.value })}
					/>
				</label>
				<label className='block min-w-0 space-y-1 text-sm'>
					<span>{t(prefix + 'statusFilter')}</span>
					<select
						className={selectClass}
						value={filters.status}
						onChange={(event) =>
							change({
								status: event.target.value as DataPolicyFilters['status'],
							})
						}
					>
						<option value='all'>{t(prefix + 'allStatuses')}</option>
						<option value='verified'>{t(prefix + 'verified')}</option>
						<option value='expired'>{t(prefix + 'expired')}</option>
						<option value='unknown'>{t(prefix + 'unknown')}</option>
					</select>
				</label>
			</div>
			{manager.list.isFetching ? (
				<p role='status' className='text-muted-foreground text-sm'>
					{t(prefix + 'loading')}
				</p>
			) : null}
			{!manager.hidden &&
			!manager.list.error &&
			!manager.list.isFetching &&
			manager.rows.length === 0 ? (
				<p className='text-muted-foreground rounded-xl border p-6 text-sm'>
					{t(prefix + 'empty')}
				</p>
			) : null}
			{noMatches && !manager.list.isFetching ? (
				<p className='text-muted-foreground rounded-xl border p-6 text-sm'>
					{t(prefix + 'noMatches')}
				</p>
			) : null}
			<div className='grid min-w-0 gap-4 lg:grid-cols-2'>
				{shown.map((row) => (
					<PolicyCard
						key={row.route_target_id}
						row={row}
						canEdit={
							!manager.disabled &&
							Boolean(row.current_subject_fingerprint) &&
							row.current_policy_fingerprint !== undefined
						}
						onEdit={() => manager.open({ kind: 'editor', row })}
						onAudit={() => manager.open({ kind: 'audit', row })}
					/>
				))}
			</div>
			{manager.panel?.kind === 'editor' ? (
				<DataPolicyEditorDialog
					key={manager.panel.row.route_target_id}
					row={manager.panel.row}
					disabled={manager.disabled}
					pending={manager.mutation.isPending}
					error={manager.mutation.error}
					onSave={(input) =>
						manager.save(manager.panel!.row.route_target_id, input)
					}
					onClose={manager.close}
				/>
			) : null}
			{manager.panel?.kind === 'audit' ? (
				<DataPolicyAuditDialog
					key={manager.panel.row.route_target_id}
					api={props.api}
					queryPrefix={manager.prefix}
					row={manager.panel.row}
					readOptions={manager.readOptions}
					onClose={manager.close}
				/>
			) : null}
		</main>
	)
}
