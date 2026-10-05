/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from '@/components/ui/dialog'
import { CinaTokenApiError } from '../../api'
import { SharedKeyAuditPanel } from './SharedKeyAuditPanel'
import { SharedKeyConfirmation } from './SharedKeyConfirmation'
import { SharedKeyEditor } from './SharedKeyEditor'
import { SharedKeyProfile } from './SharedKeyProfile'
import type { SharedKeyDialogKind } from './SharedKeysTable'
import type { AdminSharedKeysApi } from './shared-key-api'
import type { AdminSharedKeyRow } from './shared-key-contracts'
import { adminSharedKeyAccessDenied } from './shared-key-errors'
import type { AdminSharedKeyPatch } from './shared-key-input'

const prefix = 'cinatoken.adminSharedKeys.'
export function SharedKeyDetailDialog(props: {
	api: AdminSharedKeysApi
	scopeKey: string
	row: AdminSharedKeyRow
	kind: SharedKeyDialogKind
	busy: boolean
	canWrite: boolean
	canReadAudit: boolean
	error: string | null
	onClose: () => void
	onReadLost: () => void
	onWriteLost: () => void
	onAuditLost: () => void
	onSave: (row: AdminSharedKeyRow, input: AdminSharedKeyPatch) => Promise<void>
}) {
	const { t } = useTranslation()
	const query = useQuery({
		queryKey: [
			'cinatoken',
			'admin',
			props.scopeKey,
			'shared-keys',
			props.row,
			'detail',
		],
		queryFn: ({ signal }) =>
			props.api.adminSharedKeyDetail(props.row, { signal }),
		enabled: props.kind !== 'audit',
		retry: false,
		refetchOnWindowFocus: false,
		gcTime: 0,
	})
	const onReadLost = props.onReadLost
	const onWriteLost = props.onWriteLost
	useEffect(() => {
		if (adminSharedKeyAccessDenied(query.error)) onReadLost()
	}, [query.error, onReadLost])
	const writeLost = query.data?.capabilities.can_write === false
	useEffect(() => {
		if (writeLost) onWriteLost()
	}, [writeLost, onWriteLost])
	let content
	if (props.kind === 'audit')
		content = (
			<SharedKeyAuditPanel
				api={props.api}
				scopeKey={props.scopeKey}
				keyId={props.row.id}
				canRead={props.canReadAudit}
				onReadLost={props.onReadLost}
				onAuditLost={props.onAuditLost}
			/>
		)
	else if (query.error)
		content = (
			<p role='alert'>
				{t(
					prefix +
						(query.error instanceof CinaTokenApiError &&
						query.error.code === 'invalid-response'
							? 'invalidResponse'
							: 'readFailed')
				)}
			</p>
		)
	else if (!query.data) content = <p role='status'>{t(prefix + 'loading')}</p>
	else {
		const row = query.data
		const allowed = props.canWrite && row.capabilities.can_write
		let form = null
		if (props.kind === 'edit' && allowed)
			form = (
				<SharedKeyEditor
					row={row}
					busy={props.busy}
					canWrite={allowed}
					error={props.error}
					onCancel={props.onClose}
					onSave={(input) => props.onSave(row, input)}
				/>
			)
		else if (
			(props.kind === 'delete' ||
				props.kind === 'disable' ||
				props.kind === 'restore') &&
			allowed
		)
			form = (
				<SharedKeyConfirmation
					row={row}
					kind={props.kind}
					busy={props.busy}
					canWrite={allowed}
					error={props.error}
					onCancel={props.onClose}
					onConfirm={(input) => props.onSave(row, input)}
				/>
			)
		else if (props.kind !== 'details')
			form = <p role='alert'>{t(prefix + 'writeDenied')}</p>
		content = (
			<div className='space-y-5'>
				<SharedKeyProfile
					row={row}
					canReadUser={row.capabilities.user_detail}
				/>
				{form}
				{props.kind === 'details' && (
					<SharedKeyAuditPanel
						api={props.api}
						scopeKey={props.scopeKey}
						keyId={row.id}
						canRead={props.canReadAudit}
						onReadLost={props.onReadLost}
						onAuditLost={props.onAuditLost}
					/>
				)}
			</div>
		)
	}
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !props.busy) props.onClose()
			}}
		>
			<DialogContent
				showCloseButton={false}
				className='max-h-[85dvh] overflow-y-auto sm:max-w-3xl'
			>
				<DialogTitle>
					{t(prefix + (props.kind === 'audit' ? 'auditTitle' : props.kind))}
				</DialogTitle>
				<DialogDescription>{t(prefix + 'subtitle')}</DialogDescription>
				{content}
				{(props.kind === 'details' ||
					props.kind === 'audit' ||
					query.error ||
					!query.data) && (
					<div className='flex justify-end'>
						<Button type='button' variant='outline' onClick={props.onClose}>
							{t(prefix + 'close')}
						</Button>
					</div>
				)}
			</DialogContent>
		</Dialog>
	)
}
