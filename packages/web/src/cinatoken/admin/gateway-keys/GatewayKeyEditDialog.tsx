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
import { adminDomainIdentity } from '../domain-write-recovery'
import type { AdminGuardrailPreviewApi } from '../guardrails/preview-api'
import { GatewayKeyEditor } from './GatewayKeyEditor'
import type { AdminGatewayKeysApi } from './gateway-key-api'
import type {
	GatewayKeyDetail,
	GatewayKeyRow,
	GatewayKeysCapabilities,
} from './gateway-key-contracts'
import type { GatewayKeyPatch } from './gateway-key-input'
import { gatewayKeyAccessDenied } from './gateway-key-recovery'

const prefix = 'cinatoken.adminGatewayKeys.'
export function GatewayKeyEditDialog(props: {
	api: AdminGatewayKeysApi
	row: GatewayKeyRow
	capabilities: GatewayKeysCapabilities
	previewApi: AdminGuardrailPreviewApi
	scopeKey: string
	reconciliationKey: string
	currency: 'USD' | 'CNY' | null
	guardrailBlocked: boolean
	onGuardrailDenied: () => void
	busy: boolean
	canWrite: boolean
	error: string | null
	onClose: () => void
	onDenied: () => void
	onSave: (patch: GatewayKeyPatch) => Promise<void>
}) {
	const { t } = useTranslation()
	const [detail, setDetail] = useState<GatewayKeyDetail | null>(null)
	const [failed, setFailed] = useState(false)
	const api = props.api
	const row = props.row
	const onDenied = props.onDenied
	const identity = adminDomainIdentity(props.reconciliationKey)
	useEffect(() => {
		const controller = new AbortController()
		let active = true
		void api.gatewayKeyEditDetail(row, { signal: controller.signal }).then(
			(value) => {
				if (active && !controller.signal.aborted) setDetail(value)
			},
			(error: unknown) => {
				if (active && !controller.signal.aborted) {
					setFailed(true)
					if (gatewayKeyAccessDenied(error)) onDenied()
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
			<GatewayKeyEditor
				detail={detail}
				row={props.row}
				capabilities={props.capabilities}
				previewApi={props.previewApi}
				previewReadOptions={(signal) => ({
					signal,
					expectedConsoleSubject: identity?.subject ?? '',
					expectedUserId: identity?.userId ?? '',
				})}
				scopeKey={props.scopeKey}
				currency={props.currency}
				guardrailBlocked={props.guardrailBlocked}
				onGuardrailDenied={props.onGuardrailDenied}
				busy={props.busy}
				canWrite={props.canWrite}
				error={props.error}
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
				className='max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl'
			>
				<DialogTitle>{t(prefix + 'editTitle')}</DialogTitle>
				<DialogDescription>{t(prefix + 'editHint')}</DialogDescription>
				{content}
			</DialogContent>
		</Dialog>
	)
}
