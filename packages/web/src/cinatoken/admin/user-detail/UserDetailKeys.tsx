/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useEffect, useRef, useState, type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type { GatewayKeyPatch } from '../gateway-keys/gateway-key-input'
import { UserDetailKeyEditDialog } from './UserDetailKeyEditDialog'
import { UserDetailKeysTable } from './UserDetailKeysTable'
import type { AdminUserDetailApi } from './user-detail-api'
import type { UserDetailKey } from './user-detail-contracts'

const prefix = 'cinatoken.adminUserDetail.'
export function UserDetailKeys(props: {
	api: AdminUserDetailApi
	keys: UserDetailKey[] | null
	denied: boolean
	failed: boolean
	canWrite: boolean
	accessValid: boolean
	unknown: boolean
	busy: boolean
	createUnknown: boolean
	createSafetyUnavailable: boolean
	timezone: string | null
	onCreate: (
		name: string,
		metadata: string,
		onSecret: (secret: string) => void
	) => Promise<void>
	onStatus: (keyId: string, status: 'active' | 'revoked') => Promise<void>
	onDelete: (keyId: string) => Promise<void>
	onReadDenied: () => void
	onSave: (
		row: UserDetailKey,
		patch: GatewayKeyPatch
	) => Promise<'saved' | 'rejected' | 'unknown' | 'conflict'>
}) {
	const { t } = useTranslation()
	const [name, setName] = useState('')
	const [metadata, setMetadata] = useState('')
	const [secret, setSecret] = useState<string | null>(null)
	const [editRow, setEditRow] = useState<UserDetailKey | null>(null)
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
			if (active.current) setCopyFailed(false)
		} catch {
			if (active.current) setCopyFailed(true)
		}
	}
	let content: JSX.Element
	if (props.denied)
		content = (
			<p role='status' className='text-muted-foreground text-sm'>
				{t(prefix + 'keysDenied')}
			</p>
		)
	else if (props.failed)
		content = (
			<p role='alert' className='text-sm'>
				{t(prefix + 'keysFailed')}
			</p>
		)
	else if (props.keys)
		content = (
			<UserDetailKeysTable
				keys={props.keys}
				timezone={props.timezone}
				canWrite={props.canWrite}
				busy={props.busy}
				onStatus={props.onStatus}
				onDelete={props.onDelete}
				onEdit={(row) => {
					setSecret(null)
					setEditRow(row)
				}}
			/>
		)
	else
		content = (
			<p role='status' className='text-muted-foreground text-sm'>
				{t(prefix + 'loading')}
			</p>
		)
	return (
		<section className='bg-card space-y-4 rounded-xl border p-4 sm:p-6'>
			<h2 className='text-lg font-semibold'>{t(prefix + 'keys')}</h2>
			{props.createUnknown && (
				<p
					role='alert'
					className='border-destructive/40 rounded-md border p-3 text-sm'
				>
					{t(prefix + 'keyUnknown')}
				</p>
			)}
			{props.createSafetyUnavailable && (
				<p
					role='alert'
					className='border-destructive/40 rounded-md border p-3 text-sm'
				>
					{t(prefix + 'keyStorage')}
				</p>
			)}
			{secret && props.accessValid && !props.failed && !props.unknown && (
				<div
					role='status'
					className='border-primary/40 space-y-2 rounded-md border p-3 text-sm'
				>
					<p>{t(prefix + 'createdKey')}</p>
					<code className='block rounded-md border p-2 break-all select-all'>
						{secret}
					</code>
					<div className='flex gap-2'>
						<Button
							type='button'
							variant='outline'
							onClick={() => void copySecret()}
						>
							{t(prefix + 'copy')}
						</Button>
						<Button
							type='button'
							variant='outline'
							onClick={() => setSecret(null)}
						>
							{t(prefix + 'close')}
						</Button>
					</div>
					{copyFailed && <p role='alert'>{t(prefix + 'writeFailed')}</p>}
				</div>
			)}
			<div className='grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]'>
				<label className='space-y-1 text-sm'>
					<span>{t(prefix + 'keyName')}</span>
					<input
						className='bg-background w-full rounded-md border px-3 py-2'
						value={name}
						onChange={(event) => setName(event.target.value)}
						disabled={!props.canWrite}
					/>
				</label>
				<label className='space-y-1 text-sm'>
					<span>{t(prefix + 'metadata')}</span>
					<input
						className='bg-background w-full rounded-md border px-3 py-2 font-mono text-xs'
						value={metadata}
						onChange={(event) => setMetadata(event.target.value)}
						disabled={!props.canWrite}
					/>
				</label>
				<Button
					type='button'
					className='self-end'
					disabled={!props.canWrite}
					onClick={() => {
						setSecret(null)
						void props.onCreate(name, metadata, (value) => {
							if (active.current) {
								setSecret(value)
								setMetadata('')
							}
						})
					}}
				>
					{t(prefix + 'createKey')}
				</Button>
			</div>
			{content}
			{editRow && props.accessValid && !props.unknown && (
				<UserDetailKeyEditDialog
					row={editRow}
					api={props.api}
					canWrite={props.canWrite}
					busy={props.busy}
					onClose={() => setEditRow(null)}
					onDenied={props.onReadDenied}
					onSave={(patch) => props.onSave(editRow, patch)}
				/>
			)}
		</section>
	)
}
