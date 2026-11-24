/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from '@/components/ui/dialog'
import { safeLogJson } from '../request-logs/request-log-domain'
import { AuditWalletSummary } from './AuditWalletSummary'
import type { AuditLog } from './audit-log-contracts'
import { auditDiffs, auditTime } from './audit-log-display'

const prefix = 'cinatoken.adminAuditLogs.'
function RawPanel(props: { title: string; raw: string | null | undefined }) {
	const { t } = useTranslation()
	const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>(
		'idle'
	)
	const safe = safeLogJson(props.raw)
	if (!safe) return null
	async function copy(): Promise<void> {
		try {
			await navigator.clipboard.writeText(safe!)
			setCopyState('copied')
		} catch {
			setCopyState('failed')
		}
	}
	return (
		<section className='min-w-0 rounded-lg border p-3'>
			<div className='mb-2 flex items-center justify-between gap-2'>
				<h3 className='text-sm font-medium'>{props.title}</h3>
				<Button
					type='button'
					variant='outline'
					size='sm'
					onClick={() => void copy()}
				>
					{t(prefix + (copyState === 'copied' ? 'copied' : 'copy'))}
				</Button>
			</div>
			{copyState === 'failed' && (
				<p role='status' className='text-muted-foreground mb-2 text-xs'>
					{t(prefix + 'copyFailed')}
				</p>
			)}
			<pre className='bg-muted max-h-60 overflow-auto rounded-md p-3 text-xs break-all whitespace-pre-wrap'>
				{safe}
			</pre>
		</section>
	)
}
export function AuditLogDetailDialog(props: {
	log: AuditLog
	timezone: string | null
	currency: string | null
	locale: string
	returnFocus: RefObject<HTMLButtonElement | null>
	onClose: () => void
}) {
	const { t } = useTranslation()
	const title = useRef<HTMLHeadingElement>(null)
	const diffs = auditDiffs(
		props.log,
		t(prefix + 'missingSnapshot'),
		t(prefix + 'nullValue')
	)
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) props.onClose()
			}}
		>
			<DialogContent
				showCloseButton={false}
				initialFocus={title}
				finalFocus={() =>
					props.returnFocus.current?.isConnected
						? props.returnFocus.current
						: false
				}
				className='flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl'
			>
				<div className='flex shrink-0 items-start justify-between gap-3 border-b p-4 sm:p-5'>
					<div className='min-w-0 space-y-2'>
						<DialogTitle
							ref={title}
							tabIndex={-1}
							className='text-lg font-semibold'
						>
							{t(prefix + 'labels.changeDetailTitle')}
						</DialogTitle>
						<DialogDescription className='flex flex-wrap gap-2 text-xs'>
							<span className='font-mono break-all'>
								{props.log.event_type}
							</span>
							<span>
								{auditTime(props.log.created_at, props.timezone, props.locale)}
							</span>
							<span className='break-all'>{props.log.user_email ?? '—'}</span>
						</DialogDescription>
					</div>
					<Button type='button' variant='outline' onClick={props.onClose}>
						{t(prefix + 'close')}
					</Button>
				</div>
				<div className='min-h-0 space-y-4 overflow-y-auto p-4 sm:p-5'>
					<section
						className='rounded-lg border p-3'
						aria-label={t(prefix + 'table.wallet')}
					>
						<h3 className='mb-2 text-sm font-medium'>
							{t(prefix + 'table.wallet')}
						</h3>
						<AuditWalletSummary
							log={props.log}
							currency={props.currency}
							locale={props.locale}
						/>
					</section>
					{diffs.length ? (
						diffs.map((row, index) => (
							<div
								key={`${row.group}-${row.field}-${index}`}
								className='rounded-lg border p-3'
							>
								<div className='mb-2 flex flex-wrap items-center gap-2 text-sm'>
									<span className='bg-muted rounded px-2 py-0.5 text-xs'>
										{t(
											prefix +
												(row.group === 'snapshot'
													? 'labels.userSnapshot'
													: 'labels.extraJson')
										)}
									</span>
									<span className='font-mono font-medium break-all'>
										{row.field}
									</span>
								</div>
								<div className='grid gap-3 sm:grid-cols-2'>
									<div className='min-w-0'>
										<p className='text-muted-foreground mb-1 text-xs'>
											{t(prefix + 'labels.originalValue')}
										</p>
										<pre className='max-h-48 overflow-auto rounded bg-amber-500/10 p-3 text-xs break-all whitespace-pre-wrap'>
											{row.before}
										</pre>
									</div>
									<div className='min-w-0'>
										<p className='text-muted-foreground mb-1 text-xs'>
											{t(prefix + 'labels.changedValue')}
										</p>
										<pre className='max-h-48 overflow-auto rounded bg-sky-500/10 p-3 text-xs break-all whitespace-pre-wrap'>
											{row.after}
										</pre>
									</div>
								</div>
							</div>
						))
					) : (
						<p className='text-muted-foreground text-sm'>
							{t(prefix + 'labels.noChangeDetail')}
						</p>
					)}
					<RawPanel
						title={t(prefix + 'beforeSnapshot')}
						raw={props.log.before_user_snapshot}
					/>
					<RawPanel
						title={t(prefix + 'afterSnapshot')}
						raw={props.log.after_user_snapshot}
					/>
					<RawPanel
						title={t(prefix + 'changedFields')}
						raw={props.log.changed_fields}
					/>
					<RawPanel
						title={t(prefix + 'rawPayload')}
						raw={props.log.change_payload}
					/>
				</div>
			</DialogContent>
		</Dialog>
	)
}
