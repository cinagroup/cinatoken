/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { CinaTokenApiError } from '../../api'
import type { AdminSharedKeyAuditEntry } from './audit-contracts'
import type { AdminSharedKeysApi } from './shared-key-api'
import { formatSharedKeyTime } from './shared-key-display'
import { adminSharedKeyAccessDenied } from './shared-key-errors'

const prefix = 'cinatoken.adminSharedKeys.'
function Snapshot(props: {
	value: AdminSharedKeyAuditEntry['after']
	title: string
}) {
	const { t } = useTranslation()
	if (props.value === null)
		return (
			<div>
				<h4 className='text-muted-foreground text-xs'>{props.title}</h4>
				<p className='text-sm'>{t(prefix + 'operation_deleted')}</p>
			</div>
		)
	return (
		<div>
			<h4 className='text-muted-foreground text-xs'>{props.title}</h4>
			<div className='space-y-1 text-xs'>
				<div>
					{t(prefix + 'status')}: {t(prefix + 'status_' + props.value.status)}
				</div>
				<div>
					{t(prefix + 'priority')}: {props.value.sellerPriority}
				</div>
				<div>
					{t(prefix + 'weight')}: {props.value.weight}
				</div>
				<div>
					{t(prefix + (props.value.validated ? 'validated' : 'notValidated'))}
				</div>
			</div>
		</div>
	)
}
export function SharedKeyAuditPanel(props: {
	api: AdminSharedKeysApi
	scopeKey: string
	keyId: string
	canRead: boolean
	onReadLost: () => void
	onAuditLost: () => void
}) {
	const { t, i18n } = useTranslation()
	const [cursors, setCursors] = useState<(string | null)[]>([null])
	const cursor = cursors[cursors.length - 1] ?? null
	const query = useQuery({
		queryKey: [
			'cinatoken',
			'admin',
			props.scopeKey,
			'shared-keys',
			props.keyId,
			'audit',
			cursor,
		],
		queryFn: ({ signal }) =>
			props.api.adminSharedKeyAudit(props.keyId, cursor, { signal }),
		enabled: props.canRead,
		retry: false,
		refetchOnWindowFocus: false,
		gcTime: 0,
	})
	const onReadLost = props.onReadLost
	const onAuditLost = props.onAuditLost
	useEffect(() => {
		if (!adminSharedKeyAccessDenied(query.error)) return
		if (query.error instanceof CinaTokenApiError && query.error.status === 401)
			onReadLost()
		else onAuditLost()
	}, [query.error, onReadLost, onAuditLost])
	let content
	if (!props.canRead || query.error)
		content = (
			<p role='alert' className='text-muted-foreground text-sm'>
				{t(prefix + 'auditUnavailable')}
			</p>
		)
	else if (!query.data)
		content = (
			<p role='status' className='text-muted-foreground text-sm'>
				{t(prefix + 'loading')}
			</p>
		)
	else if (query.data.entries.length === 0)
		content = (
			<p className='text-muted-foreground text-sm'>
				{t(prefix + 'auditEmpty')}
			</p>
		)
	else
		content = (
			<div className='space-y-3'>
				{query.data.entries.map((entry) => (
					<article key={entry.id} className='space-y-3 rounded-lg border p-3'>
						<header className='flex flex-wrap justify-between gap-2 text-sm'>
							<strong>{t(prefix + 'operation_' + entry.action)}</strong>
							<time dateTime={entry.createdAt}>
								{formatSharedKeyTime(
									entry.createdAt,
									i18n.resolvedLanguage ?? 'en'
								)}
							</time>
						</header>
						<dl className='grid gap-2 text-xs sm:grid-cols-2'>
							<div>
								<dt className='text-muted-foreground'>
									{t(prefix + 'auditActor')}
								</dt>
								<dd className='break-all'>
									{t(prefix + 'actor_' + entry.actorKind)} · {entry.actorId}
								</dd>
							</div>
							<div>
								<dt className='text-muted-foreground'>
									{t(prefix + 'auditSource')}
								</dt>
								<dd>{t(prefix + 'source_' + entry.source)}</dd>
							</div>
							<div className='sm:col-span-2'>
								<dt className='text-muted-foreground'>
									{t(prefix + 'auditReason')}
								</dt>
								<dd className='break-all'>{entry.reason}</dd>
							</div>
						</dl>
						<div className='grid gap-3 sm:grid-cols-2'>
							<Snapshot
								value={entry.before}
								title={t(prefix + 'auditBefore')}
							/>
							<Snapshot value={entry.after} title={t(prefix + 'auditAfter')} />
						</div>
					</article>
				))}
			</div>
		)
	return (
		<section className='space-y-3'>
			<h3 className='font-semibold'>{t(prefix + 'auditTitle')}</h3>
			{content}
			{props.canRead && !query.error && (
				<div className='flex flex-wrap justify-between gap-2'>
					<Button
						type='button'
						size='sm'
						variant='outline'
						disabled={query.isFetching || cursors.length === 1}
						onClick={() => setCursors((values) => values.slice(0, -1))}
					>
						{t(prefix + 'previous')}
					</Button>
					<Button
						type='button'
						size='sm'
						variant='outline'
						disabled={query.isFetching || query.data?.next_cursor == null}
						onClick={() => {
							const next = query.data?.next_cursor
							if (next) setCursors((values) => [...values, next])
						}}
					>
						{t(prefix + 'auditMore')}
					</Button>
				</div>
			)}
		</section>
	)
}
