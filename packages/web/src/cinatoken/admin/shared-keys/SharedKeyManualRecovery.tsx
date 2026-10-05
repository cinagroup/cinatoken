/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from '@/components/ui/dialog'
import { EarningReviewResult } from './EarningReviewResult'
import { SharedKeyProfile } from './SharedKeyProfile'
import { SharedKeyRecoveryAudit } from './SharedKeyRecoveryAudit'
import type { AdminSharedKeyMarker } from './shared-key-marker'
import { useSharedKeyPending } from './use-shared-key-access'
import {
	useSharedKeyManualRecovery,
	type SharedKeyManualRecoveryProps,
} from './use-shared-key-manual-recovery'

const prefix = 'cinatoken.adminSharedKeys.'
type Props = Omit<SharedKeyManualRecoveryProps, 'marker' | 'onClose'> & {
	enabled: boolean
	canReadLogs: boolean
}
export function SharedKeyManualRecovery(props: Props) {
	const { t } = useTranslation()
	const pending = useSharedKeyPending(props.store, props.identity)
	const [opened, setOpened] = useState<AdminSharedKeyMarker | null>(null)
	if (
		!props.enabled ||
		((pending === 'ready' || pending === 'unavailable') && !opened)
	)
		return null
	const marker = props.store.marker(props.identity)
	if (!marker && !opened)
		return (
			<p role='alert' className='rounded-xl border p-4 text-sm'>
				{t(prefix + 'recoveryUnavailable')}
			</p>
		)
	return (
		<div className='space-y-3'>
			{marker && (
				<Button
					type='button'
					variant='outline'
					onClick={() => setOpened(marker)}
				>
					{t(
						prefix +
							(marker.kind === 'governance'
								? 'recoverGovernance'
								: 'recoverReview')
					)}
				</Button>
			)}
			{opened && (
				<ManualRecoveryDialog
					key={opened.generation}
					{...props}
					marker={opened}
					onClose={() => setOpened(null)}
					onRecovered={() => {
						setOpened(null)
						props.onRecovered()
					}}
				/>
			)}
		</div>
	)
}
function ManualRecoveryDialog(
	props: SharedKeyManualRecoveryProps & { canReadLogs: boolean }
) {
	const { t } = useTranslation()
	const id = useId()
	const manager = useSharedKeyManualRecovery(props)
	const evidence = manager.evidence
	let state = null
	if (evidence?.kind === 'governance') {
		let profile = (
			<p role='status' className='text-sm'>
				{t(prefix + 'recoveryMissing')}
			</p>
		)
		if (evidence.row)
			profile = (
				<>
					<SharedKeyProfile
						row={evidence.row}
						canReadUser={evidence.row.capabilities.user_detail}
					/>
					<p className='text-xs'>
						{t(prefix + 'recoveryRevision')}:{' '}
						<code className='break-all'>{evidence.row.profile_revision}</code>
					</p>
				</>
			)
		state = (
			<div className='space-y-5'>
				{profile}
				<SharedKeyRecoveryAudit
					page={evidence.audit}
					busy={manager.busy}
					cursors={manager.cursors}
					onPage={(cursor, back) => void manager.pageAudit(cursor, back)}
				/>
			</div>
		)
	} else if (evidence?.kind === 'review')
		state = (
			<EarningReviewResult
				result={evidence.result}
				canReadLogs={props.canReadLogs}
			/>
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
				className='max-h-[85dvh] overflow-y-auto sm:max-w-3xl'
			>
				<DialogTitle>
					{t(
						prefix +
							(props.marker.kind === 'governance'
								? 'recoverGovernance'
								: 'recoverReview')
					)}
				</DialogTitle>
				<DialogDescription>
					{t(
						prefix +
							(props.marker.kind === 'governance'
								? 'recoveryHint'
								: 'reviewRecoveryHint')
					)}
				</DialogDescription>
				{props.marker.kind === 'governance' && (
					<p className='text-sm'>
						{t(prefix + 'keyId')}:{' '}
						<code className='break-all'>{props.marker.keyId}</code>
					</p>
				)}
				{props.marker.kind === 'review' && (
					<p className='text-sm'>
						{t(prefix + 'since')}: <code>{props.marker.since}</code> ·{' '}
						{t(prefix + 'limit')}: {props.marker.limit}
					</p>
				)}
				<Button
					type='button'
					variant='outline'
					className='aria-disabled:opacity-50'
					focusableWhenDisabled
					disabled={manager.busy}
					onClick={() => void manager.inspect()}
				>
					{t(prefix + 'recoveryInspect')}
				</Button>
				{manager.busy && (
					<p role='status' className='text-sm'>
						{t(prefix + 'loading')}
					</p>
				)}
				{state}
				{manager.error && (
					<p role='alert' className='text-destructive text-sm'>
						{t(prefix + manager.error)}
					</p>
				)}
				<div className='flex items-start gap-2 text-sm'>
					<input
						id={id + '-ack'}
						type='checkbox'
						className='mt-1 shrink-0'
						checked={manager.acknowledged}
						disabled={manager.busy || !evidence}
						onChange={(event) => manager.setAcknowledged(event.target.checked)}
					/>
					<label htmlFor={id + '-ack'}>{t(prefix + 'recoveryAck')}</label>
				</div>
				<div className='flex flex-wrap justify-end gap-2'>
					<Button type='button' variant='outline' onClick={props.onClose}>
						{t(prefix + 'cancel')}
					</Button>
					<Button
						type='button'
						className='aria-disabled:opacity-50'
						focusableWhenDisabled
						disabled={manager.busy || !evidence || !manager.acknowledged}
						onClick={() => void manager.acknowledge()}
					>
						{t(prefix + 'recoveryConfirm')}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	)
}
