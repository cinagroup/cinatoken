/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
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
import type {
	DataPoliciesApi,
	DataPolicyRequestOptions,
} from './data-policy-api'
import type {
	DataPolicyAuditSnapshot,
	DataPolicyListRow,
} from './data-policy-contracts'
import { dataPolicyErrorKey } from './data-policy-errors'

const prefix = 'cinatoken.adminDataPolicies.'

function displayDate(value: string | null): string {
	return value ? new Date(value).toLocaleString() : '—'
}
function auditEntryLabel(snapshot: DataPolicyAuditSnapshot): string {
	if (!snapshot) return 'auditUnavailable'
	return 'event' in snapshot ? 'auditInvalidation' : 'auditPolicy'
}

function Snapshot(props: { snapshot: DataPolicyAuditSnapshot }) {
	const { t } = useTranslation()
	const snapshot = props.snapshot
	if (!snapshot)
		return (
			<p className='text-muted-foreground text-sm'>
				{t(prefix + 'auditUnavailable')}
			</p>
		)
	if ('event' in snapshot)
		return (
			<dl className='grid gap-x-3 gap-y-1 text-sm sm:grid-cols-2'>
				<dt className='text-muted-foreground'>
					{t(prefix + 'previousStatus')}
				</dt>
				<dd>{t(prefix + snapshot.previous_status)}</dd>
				<dt className='text-muted-foreground'>
					{t(prefix + 'auditInvalidation')}
				</dt>
				<dd className='break-words'>{snapshot.reason}</dd>
				<dt className='text-muted-foreground'>{t(prefix + 'fingerprint')}</dt>
				<dd className='break-all'>
					{snapshot.subject_fingerprint ?? t(prefix + 'notSet')}
				</dd>
			</dl>
		)
	return (
		<dl className='grid gap-x-3 gap-y-1 text-sm sm:grid-cols-2'>
			<dt className='text-muted-foreground'>{t(prefix + 'storedStatus')}</dt>
			<dd>{t(prefix + snapshot.status)}</dd>
			<dt className='text-muted-foreground'>{t(prefix + 'fingerprint')}</dt>
			<dd className='break-all'>
				{snapshot.subject_fingerprint ?? t(prefix + 'notSet')}
			</dd>
			<dt className='text-muted-foreground'>{t(prefix + 'verifier')}</dt>
			<dd className='break-all'>
				{snapshot.verified_by ?? t(prefix + 'notSet')}
			</dd>
			<dt className='text-muted-foreground'>{t(prefix + 'verifiedAt')}</dt>
			<dd>{displayDate(snapshot.verified_at)}</dd>
			<dt className='text-muted-foreground'>{t(prefix + 'invalidatedAt')}</dt>
			<dd>{displayDate(snapshot.invalidated_at)}</dd>
			<dt className='text-muted-foreground'>
				{t(prefix + 'auditInvalidation')}
			</dt>
			<dd className='break-words'>
				{snapshot.invalidation_reason ?? t(prefix + 'notSet')}
			</dd>
			<dt className='text-muted-foreground'>{t(prefix + 'retention')}</dt>
			<dd>{snapshot.retention_days ?? t(prefix + 'notSet')}</dd>
			<dt className='text-muted-foreground'>{t(prefix + 'training')}</dt>
			<dd>{t(prefix + (snapshot.training_allowed ? 'yes' : 'no'))}</dd>
			<dt className='text-muted-foreground'>{t(prefix + 'zdr')}</dt>
			<dd>{t(prefix + (snapshot.zdr_supported ? 'yes' : 'no'))}</dd>
			<dt className='text-muted-foreground'>{t(prefix + 'expiry')}</dt>
			<dd>{displayDate(snapshot.expires_at)}</dd>
			<dt className='text-muted-foreground'>{t(prefix + 'evidence')}</dt>
			<dd className='min-w-0 break-all'>
				{snapshot.evidence_url ? (
					<a
						href={snapshot.evidence_url}
						target='_blank'
						rel='noopener noreferrer'
						className='underline underline-offset-2'
					>
						{snapshot.evidence_url}
					</a>
				) : (
					t(prefix + 'notSet')
				)}
			</dd>
		</dl>
	)
}

export function DataPolicyAuditDialog(props: {
	api: DataPoliciesApi
	queryPrefix: readonly unknown[]
	row: DataPolicyListRow
	readOptions: (signal: AbortSignal) => DataPolicyRequestOptions
	onClose: () => void
}) {
	const { t } = useTranslation()
	const title = useRef<HTMLHeadingElement>(null)
	const audit = useQuery({
		queryKey: [...props.queryPrefix, 'audit', props.row.route_target_id],
		queryFn: ({ signal }) =>
			props.api.dataPolicyAudit(
				props.row.route_target_id,
				props.readOptions(signal)
			),
		staleTime: 0,
		refetchOnMount: 'always',
		refetchOnWindowFocus: false,
		retry: false,
	})
	const entries = !audit.error && !audit.isFetching ? audit.data : null
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) props.onClose()
			}}
		>
			<DialogContent
				initialFocus={title}
				showCloseButton={false}
				className='max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl'
			>
				<DialogHeader>
					<DialogTitle ref={title} tabIndex={-1}>
						{t(prefix + 'auditTitle')}
					</DialogTitle>
					<DialogDescription className='break-all'>
						{props.row.route_target_id}
					</DialogDescription>
				</DialogHeader>
				{audit.isFetching ? (
					<p role='status' className='text-muted-foreground text-sm'>
						{t(prefix + 'auditLoading')}
					</p>
				) : null}
				{audit.error ? (
					<p role='alert' className='text-destructive text-sm'>
						{t(dataPolicyErrorKey(audit.error))}
					</p>
				) : null}
				{entries?.length === 0 ? (
					<p className='text-muted-foreground text-sm'>
						{t(prefix + 'auditEmpty')}
					</p>
				) : null}
				{entries ? (
					<ol className='space-y-3'>
						{entries.map((entry) => (
							<li key={entry.id} className='min-w-0 rounded-lg border p-3'>
								<div className='mb-2 flex flex-wrap items-start justify-between gap-2 text-sm'>
									<strong>{t(prefix + auditEntryLabel(entry.snapshot))}</strong>
									<time dateTime={entry.created_at}>
										{displayDate(entry.created_at)}
									</time>
								</div>
								<p className='text-muted-foreground mb-2 text-xs break-all'>
									{t(prefix + 'actor')}: {entry.actor_id}
								</p>
								<Snapshot snapshot={entry.snapshot} />
							</li>
						))}
					</ol>
				) : null}
				<DialogFooter>
					<Button type='button' variant='outline' onClick={props.onClose}>
						{t(prefix + 'close')}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
