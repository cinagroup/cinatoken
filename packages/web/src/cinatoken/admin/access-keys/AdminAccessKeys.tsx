/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	useCallback,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { CinaTokenApiError } from '../../api'
import { AccessKeyEditor, type AccessKeyEditorMode } from './AccessKeyEditor'
import type { AdminAccessKeysApi } from './access-key-api'
import {
	ACCESS_KEY_DEFAULT_PERMISSIONS,
	type AccessKey,
	type AccessKeyPermission,
} from './access-key-contracts'
import {
	AccessKeyInputError,
	accessKeyDraft,
	generateAccessKeySecret,
	toggleAccessKeyPermission,
} from './access-key-domain'
import {
	AccessKeyWritePersistenceError,
	accessKeyAccessRecovery,
	accessKeyWriteRecovery,
} from './access-key-recovery'

const prefix = 'cinatoken.adminAccessKeys.'
const secretLifetimeMs = 60_000
const draftLifetimeMs = 5 * 60_000

export type AccessKeysProps = {
	api: AdminAccessKeysApi
	scopeKey: string
	reconciliationKey: string
	canWrite: boolean
	revalidate: () => Promise<void>
}

function denied(error: unknown): boolean {
	return (
		error instanceof CinaTokenApiError &&
		(error.status === 401 || error.status === 403)
	)
}

function unknownWrite(error: unknown): boolean {
	if (!(error instanceof CinaTokenApiError)) return true
	return (
		error.status === 0 ||
		error.status >= 500 ||
		error.code === 'invalid-response' ||
		error.code === 'cancelled' ||
		error.code === 'timeout' ||
		error.code === 'network'
	)
}

function writeErrorKey(error: unknown): string {
	if (error instanceof AccessKeyInputError) return 'invalidInput'
	if (error instanceof AccessKeyWritePersistenceError)
		return 'storageUnavailable'
	if (unknownWrite(error)) return 'unknownWrite'
	if (denied(error)) return 'writeDenied'
	if (error instanceof CinaTokenApiError && error.status === 409)
		return 'conflict'
	return 'writeFailed'
}

function dateText(value: string | null, locale: string, never: string): string {
	if (!value) return never
	const date = new Date(value)
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString(locale)
}

export function AdminAccessKeys(props: AccessKeysProps) {
	const { t } = useTranslation()
	const access = accessKeyAccessRecovery(props.api)
	const snapshot = useCallback(
		() => access.getSnapshot(props.reconciliationKey),
		[access, props.reconciliationKey]
	)
	const blocked = useSyncExternalStore(access.subscribe, snapshot, snapshot)
	const query = useQuery({
		queryKey: ['cinatoken', 'admin', props.scopeKey, 'access-keys'],
		queryFn: ({ signal }) => props.api.listAccessKeys({ signal }),
		enabled: !blocked,
		retry: false,
		refetchOnWindowFocus: false,
		gcTime: 0,
	})
	const queryDenied = denied(query.error)
	const revalidate = props.revalidate
	useEffect(() => {
		if (queryDenied && access.block(props.reconciliationKey))
			void revalidate().catch(() => undefined)
	}, [access, props.reconciliationKey, queryDenied, revalidate])
	const onDenied = useCallback(() => {
		if (access.block(props.reconciliationKey))
			void revalidate().catch(() => undefined)
	}, [access, props.reconciliationKey, revalidate])
	const deniedView = blocked || queryDenied
	return (
		<main className='min-w-0 space-y-5'>
			<header>
				<h1 className='text-2xl font-semibold'>{t(prefix + 'title')}</h1>
				<p className='text-muted-foreground mt-1 text-sm'>
					{t(prefix + 'subtitle')}
				</p>
				<p className='text-muted-foreground mt-2 text-xs'>
					{t(prefix + 'consoleOnly')}
				</p>
			</header>
			{deniedView ? (
				<p role='alert' className='border-destructive/40 rounded-xl border p-5'>
					{t(prefix + 'accessDenied')}
				</p>
			) : query.error ? (
				<div
					role='alert'
					className='border-destructive/40 rounded-xl border p-5'
				>
					<p>
						{t(
							prefix +
								(query.error instanceof CinaTokenApiError &&
								query.error.code === 'invalid-response'
									? 'invalidResponse'
									: 'readFailed')
						)}
					</p>
					<Button
						type='button'
						variant='outline'
						className='mt-3'
						onClick={() => void query.refetch()}
					>
						{t(prefix + 'refresh')}
					</Button>
				</div>
			) : query.data ? (
				<AccessKeyManager
					key={JSON.stringify([
						props.scopeKey,
						props.reconciliationKey,
						props.canWrite,
					])}
					api={props.api}
					rows={query.data}
					reconciliationKey={props.reconciliationKey}
					canWrite={props.canWrite}
					onDenied={onDenied}
					onRefresh={() => void query.refetch()}
				/>
			) : (
				<p role='status' className='text-muted-foreground py-12 text-center'>
					{t(prefix + 'loading')}
				</p>
			)}
		</main>
	)
}

type ManagerProps = {
	api: AdminAccessKeysApi
	rows: AccessKey[]
	reconciliationKey: string
	canWrite: boolean
	onDenied: () => void
	onRefresh: () => void
}

function AccessKeyManager(props: ManagerProps) {
	const { t, i18n } = useTranslation()
	const writeRecovery = accessKeyWriteRecovery(props.api)
	const writeSnapshot = useCallback(
		() => writeRecovery.status(props.reconciliationKey),
		[writeRecovery, props.reconciliationKey]
	)
	const writeStatus = useSyncExternalStore(
		writeRecovery.subscribe,
		writeSnapshot,
		writeSnapshot
	)
	const active = useRef(true)
	const busyRef = useRef(false)
	const readAbort = useRef<AbortController | null>(null)
	const [busy, setBusy] = useState(false)
	const [readBusyId, setReadBusyId] = useState<string | null>(null)
	const [errorKey, setErrorKey] = useState<string | null>(null)
	const [editor, setEditor] = useState<AccessKeyEditorMode | null>(null)
	const [name, setName] = useState('')
	const [description, setDescription] = useState('')
	const [permissions, setPermissions] = useState<AccessKeyPermission[]>(
		ACCESS_KEY_DEFAULT_PERMISSIONS
	)
	const [draftSecret, setDraftSecret] = useState<string | null>(null)
	const [draftVisible, setDraftVisible] = useState(false)
	const [draftExpired, setDraftExpired] = useState(false)
	const [revealed, setRevealed] = useState<{ id: string; key: string } | null>(
		null
	)
	const [savedSecret, setSavedSecret] = useState<string | null>(null)
	const [copiedId, setCopiedId] = useState<string | null>(null)
	const [confirmStatus, setConfirmStatus] = useState<AccessKey | null>(null)
	const canWrite = props.canWrite && writeStatus === 'ready' && !busy
	useEffect(() => {
		active.current = true
		return () => {
			active.current = false
			readAbort.current?.abort()
		}
	}, [])
	useEffect(() => {
		if (!revealed) return
		const timer = window.setTimeout(() => setRevealed(null), secretLifetimeMs)
		return () => window.clearTimeout(timer)
	}, [revealed])
	useEffect(() => {
		if (!savedSecret) return
		const timer = window.setTimeout(
			() => setSavedSecret(null),
			secretLifetimeMs
		)
		return () => window.clearTimeout(timer)
	}, [savedSecret])
	useEffect(() => {
		if (!draftSecret) return
		const timer = window.setTimeout(() => {
			setDraftSecret(null)
			setDraftVisible(false)
			setDraftExpired(true)
		}, draftLifetimeMs)
		return () => window.clearTimeout(timer)
	}, [draftSecret])
	useEffect(() => {
		if (!copiedId) return
		const timer = window.setTimeout(() => setCopiedId(null), 1_500)
		return () => window.clearTimeout(timer)
	}, [copiedId])

	function openCreate(): void {
		if (!canWrite) return
		readAbort.current?.abort()
		setErrorKey(null)
		setSavedSecret(null)
		setRevealed(null)
		setEditor({ kind: 'create' })
		setName('')
		setDescription('')
		setPermissions([...ACCESS_KEY_DEFAULT_PERMISSIONS])
		setDraftSecret(generateAccessKeySecret())
		setDraftVisible(true)
		setDraftExpired(false)
	}
	function openEdit(key: AccessKey): void {
		if (!canWrite) return
		readAbort.current?.abort()
		setErrorKey(null)
		setSavedSecret(null)
		setRevealed(null)
		setEditor({ kind: 'edit', key })
		setName(key.name)
		setDescription(key.description ?? '')
		setPermissions([...key.permissions])
		setDraftSecret(null)
		setDraftVisible(false)
		setDraftExpired(false)
	}
	function closeEditor(): void {
		if (busy) return
		readAbort.current?.abort()
		setEditor(null)
		setDraftSecret(null)
		setRevealed(null)
	}
	function failRead(error: unknown, fallback: string): void {
		if (!active.current) return
		if (denied(error)) {
			setDraftSecret(null)
			setRevealed(null)
			setSavedSecret(null)
			props.onDenied()
		} else setErrorKey(fallback)
	}
	async function readSecret(key: AccessKey): Promise<string | null> {
		if (busyRef.current) return null
		readAbort.current?.abort()
		const controller = new AbortController()
		readAbort.current = controller
		setReadBusyId(key.id)
		try {
			const secret = await props.api.revealAccessKey(key.id, {
				signal: controller.signal,
			})
			return active.current && !controller.signal.aborted ? secret : null
		} catch (error) {
			if (!controller.signal.aborted) failRead(error, 'secretReadFailed')
			return null
		} finally {
			if (readAbort.current === controller) {
				readAbort.current = null
				if (active.current) setReadBusyId(null)
			}
		}
	}
	async function toggleReveal(key: AccessKey): Promise<void> {
		setErrorKey(null)
		if (revealed?.id === key.id) {
			setRevealed(null)
			return
		}
		setRevealed(null)
		const secret = await readSecret(key)
		if (secret) setRevealed({ id: key.id, key: secret })
	}
	async function copyText(secret: string, id: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(secret)
			if (active.current) setCopiedId(id)
		} catch {
			if (active.current) setErrorKey('copyFailed')
		}
	}
	async function copyExisting(key: AccessKey): Promise<void> {
		setErrorKey(null)
		const secret =
			revealed?.id === key.id ? revealed.key : await readSecret(key)
		if (secret && active.current) await copyText(secret, key.id)
	}
	async function performWrite(
		action: () => Promise<AccessKey>,
		secretAfterSave: string | null
	): Promise<void> {
		if (!canWrite || busyRef.current) return
		try {
			writeRecovery.markPending(props.reconciliationKey)
		} catch (error) {
			setErrorKey(writeErrorKey(error))
			return
		}
		busyRef.current = true
		setBusy(true)
		setErrorKey(null)
		readAbort.current?.abort()
		setRevealed(null)
		setSavedSecret(null)
		let confirmed = false
		try {
			await action()
			confirmed = true
			writeRecovery.settleKnown(props.reconciliationKey)
			if (active.current) {
				setEditor(null)
				setDraftSecret(null)
				setConfirmStatus(null)
				setSavedSecret(secretAfterSave)
				props.onRefresh()
			}
		} catch (error) {
			let failure = error
			if (!confirmed && !unknownWrite(error)) {
				try {
					writeRecovery.settleKnown(props.reconciliationKey)
				} catch (settleError) {
					failure = settleError
				}
			}
			if (active.current) {
				setErrorKey(writeErrorKey(failure))
				if (unknownWrite(failure)) {
					setEditor(null)
					setDraftSecret(null)
					setConfirmStatus(null)
				}
				if (denied(failure)) {
					setSavedSecret(null)
					props.onDenied()
				}
			}
		} finally {
			busyRef.current = false
			if (active.current) setBusy(false)
		}
	}
	function saveEditor(): void {
		if (!editor || !canWrite || draftExpired) return
		try {
			const draft = accessKeyDraft(name, description, permissions, draftSecret)
			if (editor.kind === 'create') {
				if (!draft.secret_key) throw new AccessKeyInputError()
				void performWrite(
					() => props.api.createAccessKey(draft),
					draft.secret_key
				)
			} else {
				void performWrite(
					() => props.api.patchAccessKey(editor.key.id, draft),
					draft.secret_key ?? null
				)
			}
		} catch (error) {
			setErrorKey(writeErrorKey(error))
		}
	}
	function changeStatus(): void {
		if (!confirmStatus || !canWrite) return
		const next = confirmStatus.status === 'active' ? 'revoked' : 'active'
		void performWrite(
			() => props.api.patchAccessKey(confirmStatus.id, { status: next }),
			null
		)
	}

	return (
		<>
			<div className='flex flex-wrap items-center justify-between gap-3'>
				<p className='text-muted-foreground text-sm'>
					{props.rows.length} {t(prefix + 'title').toLowerCase()}
				</p>
				<div className='flex flex-wrap gap-2'>
					<Button type='button' variant='outline' onClick={props.onRefresh}>
						{t(prefix + 'refresh')}
					</Button>
					<Button type='button' disabled={!canWrite} onClick={openCreate}>
						{t(prefix + 'create')}
					</Button>
				</div>
			</div>
			{writeStatus !== 'ready' && (
				<p
					role='alert'
					className='rounded-xl border border-amber-500/50 p-4 text-sm'
				>
					{t(
						prefix +
							(writeStatus === 'pending'
								? 'pendingWrite'
								: 'storageUnavailable')
					)}
				</p>
			)}
			{errorKey && (
				<p
					role='alert'
					className='border-destructive/40 rounded-xl border p-4 text-sm'
				>
					{t(prefix + errorKey)}
				</p>
			)}
			{savedSecret && (
				<section className='space-y-2 rounded-xl border border-emerald-500/40 p-4'>
					<h2 className='font-semibold'>{t(prefix + 'savedSecretTitle')}</h2>
					<p className='text-muted-foreground text-sm'>
						{t(prefix + 'savedSecretHint')}
					</p>
					<code className='bg-muted block rounded p-2 text-xs break-all'>
						{savedSecret}
					</code>
					<div className='flex gap-2'>
						<Button
							type='button'
							variant='outline'
							onClick={() => void copyText(savedSecret, 'saved')}
						>
							{copiedId === 'saved' ? t(prefix + 'copied') : t(prefix + 'copy')}
						</Button>
						<Button
							type='button'
							variant='outline'
							onClick={() => setSavedSecret(null)}
						>
							{t(prefix + 'hide')}
						</Button>
					</div>
				</section>
			)}
			{props.rows.length === 0 ? (
				<p className='text-muted-foreground rounded-xl border p-10 text-center'>
					{t(prefix + 'empty')}
				</p>
			) : (
				<div className='grid gap-3'>
					{props.rows.map((key) => (
						<section
							key={key.id}
							className='min-w-0 space-y-3 rounded-xl border p-4'
						>
							<div className='flex flex-wrap items-start justify-between gap-3'>
								<div className='min-w-0'>
									<h2 className='font-semibold'>{key.name}</h2>
									<p className='text-muted-foreground text-sm break-all'>
										{key.description || key.id}
									</p>
								</div>
								<span className='bg-muted rounded-full px-2 py-1 text-xs'>
									{t(prefix + key.status)}
								</span>
							</div>
							<div>
								<p className='text-muted-foreground text-xs'>
									{t(prefix + 'key')}
								</p>
								<code className='block text-xs break-all'>
									{revealed?.id === key.id ? revealed.key : key.key}
								</code>
							</div>
							<div className='flex flex-wrap gap-1'>
								{key.permissions.map((permission) => (
									<code
										key={permission}
										className='bg-muted rounded px-1.5 py-0.5 text-xs'
									>
										{permission}
									</code>
								))}
							</div>
							<p className='text-muted-foreground text-xs'>
								{t(prefix + 'lastUsed')}:{' '}
								{dateText(
									key.last_used_at,
									i18n.resolvedLanguage || 'en',
									t(prefix + 'never')
								)}
							</p>
							<div className='flex flex-wrap gap-2'>
								<Button
									type='button'
									size='sm'
									variant='outline'
									disabled={busy || readBusyId === key.id}
									onClick={() => void toggleReveal(key)}
								>
									{t(prefix + (revealed?.id === key.id ? 'hide' : 'reveal'))}
								</Button>
								<Button
									type='button'
									size='sm'
									variant='outline'
									disabled={busy || readBusyId === key.id}
									onClick={() => void copyExisting(key)}
								>
									{copiedId === key.id
										? t(prefix + 'copied')
										: t(prefix + 'copy')}
								</Button>
								<Button
									type='button'
									size='sm'
									variant='outline'
									disabled={!canWrite}
									onClick={() => openEdit(key)}
								>
									{t(prefix + 'edit')}
								</Button>
								<Button
									type='button'
									size='sm'
									variant='outline'
									disabled={!canWrite}
									onClick={() => {
										readAbort.current?.abort()
										setRevealed(null)
										setSavedSecret(null)
										setConfirmStatus(key)
									}}
								>
									{t(
										prefix + (key.status === 'active' ? 'revoke' : 'activate')
									)}
								</Button>
							</div>
						</section>
					))}
				</div>
			)}
			{editor && (
				<AccessKeyEditor
					editor={editor}
					name={name}
					description={description}
					permissions={permissions}
					draftSecret={draftSecret}
					draftVisible={draftVisible}
					draftExpired={draftExpired}
					revealed={revealed}
					copiedId={copiedId}
					readBusyId={readBusyId}
					errorKey={errorKey}
					busy={busy}
					canWrite={canWrite}
					onClose={closeEditor}
					onName={setName}
					onDescription={setDescription}
					onPermission={(permission) =>
						setPermissions((current) =>
							toggleAccessKeyPermission(current, permission)
						)
					}
					onReveal={() => {
						if (editor.kind === 'edit') void toggleReveal(editor.key)
					}}
					onCopy={() => {
						if (editor.kind === 'edit') void copyExisting(editor.key)
					}}
					onToggleDraftVisible={() => setDraftVisible((value) => !value)}
					onCopyDraft={() => {
						if (draftSecret) void copyText(draftSecret, 'draft')
					}}
					onRegenerate={() => {
						setDraftSecret(generateAccessKeySecret())
						setDraftVisible(true)
						setDraftExpired(false)
					}}
					onSave={saveEditor}
				/>
			)}
			{confirmStatus && (
				<Dialog
					open
					onOpenChange={(open) => {
						if (!open && !busy) setConfirmStatus(null)
					}}
				>
					<DialogContent
						showCloseButton={false}
						className='space-y-4 sm:max-w-md'
					>
						<DialogTitle className='text-lg font-semibold'>
							{confirmStatus.name}
						</DialogTitle>
						{errorKey && (
							<p role='alert' className='text-destructive text-sm'>
								{t(prefix + errorKey)}
							</p>
						)}
						<p className='text-sm'>
							{t(
								prefix +
									(confirmStatus.status === 'active'
										? 'confirmRevoke'
										: 'confirmActivate')
							)}
						</p>
						<div className='flex justify-end gap-2'>
							<Button
								type='button'
								variant='outline'
								disabled={busy}
								onClick={() => setConfirmStatus(null)}
							>
								{t(prefix + 'cancel')}
							</Button>
							<Button type='button' disabled={!canWrite} onClick={changeStatus}>
								{t(prefix + (busy ? 'saving' : 'confirm'))}
							</Button>
						</div>
					</DialogContent>
				</Dialog>
			)}
		</>
	)
}
