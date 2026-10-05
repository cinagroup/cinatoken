/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type { AdminSharedKeyAuditPage } from './audit-contracts'

const prefix = 'cinatoken.adminSharedKeys.'
export function SharedKeyRecoveryAudit(props: {
	page: AdminSharedKeyAuditPage
	busy: boolean
	cursors: (string | null)[]
	onPage: (cursor: string | null, back?: boolean) => void
}) {
	const { t } = useTranslation()
	return (
		<section className='space-y-3'>
			<h3 className='font-semibold'>{t(prefix + 'auditTitle')}</h3>
			<p className='text-muted-foreground text-xs'>
				{t(prefix + 'recoveryAuditScope')}
			</p>
			{props.page.entries.length === 0 && (
				<p className='text-sm'>{t(prefix + 'auditEmpty')}</p>
			)}
			{props.page.entries.map((entry) => (
				<article
					key={entry.id}
					className='space-y-2 rounded-lg border p-3 text-xs'
				>
					<header className='flex flex-wrap justify-between gap-2'>
						<strong>{t(prefix + 'operation_' + entry.action)}</strong>
						<time dateTime={entry.createdAt}>{entry.createdAt}</time>
					</header>
					<p className='break-all'>
						{t(prefix + 'auditActor')}: {t(prefix + 'actor_' + entry.actorKind)}{' '}
						· {entry.actorId}
					</p>
					<p>
						{t(prefix + 'auditSource')}: {t(prefix + 'source_' + entry.source)}
					</p>
					<p className='break-all'>
						{t(prefix + 'auditReason')}: {entry.reason}
					</p>
					{(['before', 'after'] as const).map((field) => {
						const snapshot = entry[field]
						return (
							<div key={field}>
								<h4 className='text-muted-foreground'>
									{t(
										prefix + (field === 'before' ? 'auditBefore' : 'auditAfter')
									)}
								</h4>
								{snapshot ? (
									<p>
										{t(prefix + 'status')}:{' '}
										{t(prefix + 'status_' + snapshot.status)} ·{' '}
										{t(prefix + 'priority')}: {snapshot.sellerPriority} ·{' '}
										{t(prefix + 'weight')}: {snapshot.weight} ·{' '}
										{t(
											prefix +
												(snapshot.validated ? 'validated' : 'notValidated')
										)}
									</p>
								) : (
									<p>{t(prefix + 'operation_deleted')}</p>
								)}
							</div>
						)
					})}
					<code className='block break-all'>{entry.id}</code>
				</article>
			))}
			<div className='flex flex-wrap justify-between gap-2'>
				<Button
					type='button'
					variant='outline'
					size='sm'
					className='aria-disabled:opacity-50'
					focusableWhenDisabled
					disabled={props.busy || props.cursors.length <= 1}
					onClick={() =>
						props.onPage(props.cursors[props.cursors.length - 2] ?? null, true)
					}
				>
					{t(prefix + 'previous')}
				</Button>
				<Button
					type='button'
					variant='outline'
					size='sm'
					className='aria-disabled:opacity-50'
					focusableWhenDisabled
					disabled={props.busy || props.page.next_cursor === null}
					onClick={() => props.onPage(props.page.next_cursor)}
				>
					{t(prefix + 'auditMore')}
				</Button>
			</div>
		</section>
	)
}
