/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '../../components/ui/dialog'
import type { AdminDomainRecoveryController } from './use-domain-write-recovery'

const prefix = 'cinatoken.adminDomain.'
export function AdminDomainRecoveryDialog(props: {
	recovery: AdminDomainRecoveryController
	busy?: boolean
}) {
	const { t } = useTranslation()
	if (props.recovery.status === 'ready') return null
	let stateMessage = 'unknown'
	if (props.recovery.status === 'unavailable')
		stateMessage = 'storageUnavailable'
	else if (props.busy || props.recovery.busy) stateMessage = 'writing'
	return (
		<div className='space-y-3 rounded-xl border p-4'>
			<p role='alert'>{t(prefix + stateMessage)}</p>
			{props.recovery.error && !props.recovery.open && (
				<p role='alert' className='text-destructive'>
					{t(prefix + 'reviewFailed')}
				</p>
			)}
			<Button
				variant='outline'
				disabled={
					!props.recovery.allowed ||
					props.recovery.status === 'unavailable' ||
					props.recovery.pending ||
					props.recovery.busy ||
					props.busy
				}
				onClick={props.recovery.show}
			>
				{t(prefix + 'review')}
			</Button>
			{props.recovery.open && <RecoveryDialog recovery={props.recovery} />}
		</div>
	)
}
function RecoveryDialog(props: { recovery: AdminDomainRecoveryController }) {
	const { t } = useTranslation()
	const title = useRef<HTMLHeadingElement>(null)
	const [external, setExternal] = useState(false)
	const [unknown, setUnknown] = useState(false)
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) props.recovery.close()
			}}
		>
			<DialogContent
				initialFocus={title}
				showCloseButton={false}
				className='max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl'
			>
				<DialogHeader>
					<DialogTitle ref={title} tabIndex={-1}>
						{t(prefix + 'review')}
					</DialogTitle>
					<DialogDescription>{t(prefix + 'reviewHint')}</DialogDescription>
				</DialogHeader>
				<label className='flex items-start gap-3'>
					<input
						type='checkbox'
						checked={external}
						disabled={
							!props.recovery.allowed ||
							props.recovery.pending ||
							props.recovery.busy
						}
						onChange={(event) => setExternal(event.target.checked)}
					/>
					{t(prefix + 'external')}
				</label>
				<label className='flex items-start gap-3'>
					<input
						type='checkbox'
						checked={unknown}
						disabled={
							!props.recovery.allowed ||
							props.recovery.pending ||
							props.recovery.busy
						}
						onChange={(event) => setUnknown(event.target.checked)}
					/>
					{t(prefix + 'acceptUnknown')}
				</label>
				{props.recovery.error && (
					<p role='alert' className='text-destructive'>
						{t(prefix + 'reviewFailed')}
					</p>
				)}
				<div className='flex flex-wrap justify-end gap-2'>
					<Button variant='outline' onClick={props.recovery.close}>
						{t(prefix + 'cancel')}
					</Button>
					<Button
						disabled={
							!props.recovery.allowed ||
							!external ||
							!unknown ||
							props.recovery.pending ||
							props.recovery.busy
						}
						onClick={() => void props.recovery.review(external, unknown)}
					>
						{t(prefix + 'unlock')}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	)
}
