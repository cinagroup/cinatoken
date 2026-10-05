/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type { AdminGuardrailPreviewApi } from '../guardrails/preview-api'
import {
	GatewayKeyConfirmDialog,
	type GatewayKeyConfirmation,
} from './GatewayKeyConfirmDialog'
import { GatewayKeyCreateDialog } from './GatewayKeyCreateDialog'
import { GatewayKeyEditDialog } from './GatewayKeyEditDialog'
import { GatewayKeysTable } from './GatewayKeysTable'
import type { GatewayKeyRow, GatewayKeysList } from './gateway-key-contracts'
import type { useGatewayKeys, GatewayKeysProps } from './use-gateway-keys'

const prefix = 'cinatoken.adminGatewayKeys.'
export function GatewayKeysManager(props: {
	context: GatewayKeysProps
	manager: ReturnType<typeof useGatewayKeys>
	page: GatewayKeysList
	previewApi: AdminGuardrailPreviewApi
	onPage: (page: number) => void
}) {
	const { t } = useTranslation()
	const [createOpen, setCreateOpen] = useState(false)
	const [editRow, setEditRow] = useState<GatewayKeyRow | null>(null)
	const [confirmation, setConfirmation] =
		useState<GatewayKeyConfirmation | null>(null)
	const [secret, setSecret] = useState<string | null>(null)
	const [copied, setCopied] = useState(false)
	const [copyFailed, setCopyFailed] = useState(false)
	const active = useRef(true)
	useEffect(() => {
		active.current = true
		return () => {
			active.current = false
		}
	}, [])
	useEffect(() => {
		if (!secret) return
		const timer = window.setTimeout(() => setSecret(null), 60_000)
		return () => window.clearTimeout(timer)
	}, [secret])
	async function copySecret(): Promise<void> {
		if (!secret) return
		try {
			await navigator.clipboard.writeText(secret)
			if (active.current) {
				setCopied(true)
				setCopyFailed(false)
			}
		} catch {
			if (active.current) setCopyFailed(true)
		}
	}
	const manager = props.manager
	const totalPages = Math.max(1, Math.ceil(props.page.total / 20))
	function openEdit(row: GatewayKeyRow): void {
		setSecret(null)
		setCreateOpen(false)
		setConfirmation(null)
		setEditRow(row)
	}
	return (
		<section className='space-y-4' aria-busy={manager.query.isFetching}>
			<div className='flex flex-wrap items-center justify-between gap-3'>
				<p className='text-muted-foreground text-sm'>
					{t(prefix + 'total', { count: props.page.total })}
				</p>
				<Button
					type='button'
					disabled={!manager.canWrite}
					onClick={() => {
						setSecret(null)
						setEditRow(null)
						setConfirmation(null)
						setCreateOpen(true)
					}}
				>
					{t(prefix + 'create')}
				</Button>
			</div>
			{secret && (
				<section
					role='status'
					className='border-primary/40 space-y-3 rounded-xl border p-4'
				>
					<h2 className='font-semibold'>{t(prefix + 'createdSecret')}</h2>
					<p className='text-muted-foreground text-sm'>
						{t(prefix + 'secretHint')}
					</p>
					<code className='bg-muted block rounded-md p-3 text-xs break-all select-all'>
						{secret}
					</code>
					<div className='flex gap-2'>
						<Button
							type='button'
							variant='outline'
							onClick={() => void copySecret()}
						>
							{t(prefix + (copied ? 'copied' : 'copySecret'))}
						</Button>
						<Button
							type='button'
							variant='outline'
							onClick={() => setSecret(null)}
						>
							{t(prefix + 'hideSecret')}
						</Button>
					</div>
					{copyFailed && (
						<p role='alert' className='text-destructive text-sm'>
							{t(prefix + 'copyFailed')}
						</p>
					)}
				</section>
			)}
			<GatewayKeysTable
				rows={props.page.data}
				capabilities={props.page.capabilities}
				currency={manager.currency}
				canWrite={manager.canWrite}
				onEdit={openEdit}
				onStatus={(row) => {
					setSecret(null)
					setConfirmation({
						row,
						kind: row.status === 'active' ? 'revoke' : 'activate',
					})
				}}
				onTombstone={(row) => {
					setSecret(null)
					setConfirmation({ row, kind: 'tombstone' })
				}}
			/>
			<div className='flex flex-wrap items-center justify-between gap-3'>
				<p className='text-muted-foreground text-sm'>
					{t(prefix + 'pageOf', {
						page: props.context.search.page,
						totalPages,
					})}
				</p>
				<div className='flex gap-2'>
					<Button
						type='button'
						variant='outline'
						disabled={
							props.context.search.page <= 1 ||
							manager.query.isFetching ||
							manager.busy
						}
						onClick={() => props.onPage(props.context.search.page - 1)}
					>
						{t(prefix + 'previous')}
					</Button>
					<Button
						type='button'
						variant='outline'
						disabled={
							props.context.search.page >= totalPages ||
							manager.query.isFetching ||
							manager.busy
						}
						onClick={() => props.onPage(props.context.search.page + 1)}
					>
						{t(prefix + 'next')}
					</Button>
				</div>
			</div>
			{createOpen && (
				<GatewayKeyCreateDialog
					busy={manager.busy}
					canWrite={manager.canWrite}
					error={manager.writeError}
					onClose={() => setCreateOpen(false)}
					onCreate={async (draft) => {
						setCopied(false)
						setCopyFailed(false)
						const outcome = await manager.perform((signal) =>
							props.context.api.createGatewayKey(
								draft,
								(value) => {
									if (active.current) setSecret(value)
								},
								{ signal }
							)
						)
						if (active.current && outcome !== 'rejected') setCreateOpen(false)
					}}
				/>
			)}
			{editRow && (
				<GatewayKeyEditDialog
					key={editRow.id}
					api={props.context.api}
					row={editRow}
					capabilities={props.page.capabilities}
					previewApi={props.previewApi}
					scopeKey={props.context.scopeKey}
					reconciliationKey={props.context.reconciliationKey}
					currency={manager.currency}
					guardrailBlocked={manager.guardrailBlocked}
					onGuardrailDenied={manager.invalidateGuardrail}
					busy={manager.busy}
					canWrite={manager.canWrite}
					error={manager.writeError}
					onClose={() => setEditRow(null)}
					onDenied={manager.invalidateRead}
					onSave={async (patch) => {
						const outcome = await manager.perform((signal) =>
							props.context.api.patchGatewayKey(editRow, patch, { signal })
						)
						if (active.current && outcome !== 'rejected') setEditRow(null)
					}}
				/>
			)}
			{confirmation && (
				<GatewayKeyConfirmDialog
					confirmation={confirmation}
					busy={manager.busy}
					canWrite={manager.canWrite}
					error={manager.writeError}
					onClose={() => setConfirmation(null)}
					onConfirm={async (reason) => {
						const row = confirmation.row
						const outcome = await manager.perform((signal) => {
							if (confirmation.kind === 'tombstone')
								return props.context.api.tombstoneGatewayKey(row, reason, {
									signal,
								})
							const status =
								confirmation.kind === 'activate' ? 'active' : 'revoked'
							return props.context.api.patchGatewayKey(
								row,
								{ expected_revision: row.profile_revision, status, reason },
								{ signal }
							)
						})
						if (active.current && outcome !== 'rejected') setConfirmation(null)
					}}
				/>
			)}
		</section>
	)
}
