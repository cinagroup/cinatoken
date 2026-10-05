/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useEffect, useState, type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from '@/components/ui/dialog'
import type { GatewayKeyDetail } from '../gateway-keys/gateway-key-contracts'
import type { GatewayKeyPatch } from '../gateway-keys/gateway-key-input'
import { userAccessDenied } from '../users/users-errors'
import { UserDetailKeyEditor } from './UserDetailKeyEditor'
import type { AdminUserDetailApi } from './user-detail-api'
import type { UserDetailKey } from './user-detail-contracts'

const prefix = 'cinatoken.adminGatewayKeys.'
export function UserDetailKeyEditDialog(props: {
	api: AdminUserDetailApi
	row: UserDetailKey
	canWrite: boolean
	busy: boolean
	onClose: () => void
	onDenied: () => void
	onSave: (
		patch: GatewayKeyPatch
	) => Promise<'saved' | 'rejected' | 'unknown' | 'conflict'>
}) {
	const { t } = useTranslation()
	const [detail, setDetail] = useState<GatewayKeyDetail | null>(null)
	const [failed, setFailed] = useState(false)
	const api = props.api
	const row = props.row
	const onDenied = props.onDenied
	useEffect(() => {
		const controller = new AbortController()
		let active = true
		void api.userDetailKeyEditDetail(row, { signal: controller.signal }).then(
			(value) => {
				if (active && !controller.signal.aborted) setDetail(value)
			},
			(error: unknown) => {
				if (active && !controller.signal.aborted) {
					setFailed(true)
					if (userAccessDenied(error)) onDenied()
				}
			}
		)
		return () => {
			active = false
			controller.abort()
		}
	}, [api, row, onDenied])
	let content: JSX.Element
	if (failed)
		content = (
			<div role='alert' className='space-y-3'>
				<p>{t(prefix + 'detailFailed')}</p>
				<Button type='button' variant='outline' onClick={props.onClose}>
					{t(prefix + 'close')}
				</Button>
			</div>
		)
	else if (detail)
		content = (
			<UserDetailKeyEditor
				detail={detail}
				busy={props.busy}
				canWrite={props.canWrite}
				onClose={props.onClose}
				onSave={props.onSave}
			/>
		)
	else
		content = (
			<div className='space-y-3'>
				<p role='status'>{t(prefix + 'loading')}</p>
				<Button type='button' variant='outline' onClick={props.onClose}>
					{t(prefix + 'cancel')}
				</Button>
			</div>
		)
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !props.busy) props.onClose()
			}}
		>
			<DialogContent
				showCloseButton={false}
				className='max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl'
			>
				<DialogTitle>{t(prefix + 'editTitle')}</DialogTitle>
				<DialogDescription>{t(prefix + 'editHint')}</DialogDescription>
				{content}
			</DialogContent>
		</Dialog>
	)
}
