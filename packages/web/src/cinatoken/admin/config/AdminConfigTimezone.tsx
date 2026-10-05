/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
	adminConfigAccessRecovery,
	configAccessIdentityKey,
} from './config-access-recovery'
import type { AdminConfigApi } from './config-api'
import {
	normalizeBusinessTimezoneWrite,
	type AdminConfigRevision,
} from './config-contracts'
import {
	configAccessLost,
	configErrorKey,
	configInvalidResponse,
	configWriteUncertain,
} from './config-errors'
import { adminConfigWriteRecovery } from './config-write-recovery'

const prefix = 'cinatoken.adminConfigTimezone.'
const sourceLabels = {
	configured: 'sourceConfigured',
	legacy: 'sourceLegacy',
	missing: 'sourceMissing',
	invalid: 'sourceInvalid',
	unsupported: 'sourceUnsupported',
} as const

export type AdminConfigTimezoneProps = {
	api: AdminConfigApi
	scopeKey: string
	/** Stable user ID, verified Console subject and portal epoch. */
	reconciliationKey: string
	canWrite: boolean
	revalidate: () => Promise<void>
}

export function AdminConfigTimezone(props: AdminConfigTimezoneProps) {
	const { t } = useTranslation()
	const client = useQueryClient()
	const revalidate = props.revalidate
	const queryKey = useMemo(
		() => ['cinatoken', 'admin', props.scopeKey, 'config-overview'] as const,
		[props.scopeKey]
	)
	const recovery = adminConfigWriteRecovery(props.api)
	const access = adminConfigAccessRecovery(props.api)
	const accessKey = configAccessIdentityKey(props.reconciliationKey)
	const accessSnapshot = useCallback(
		() => access.getSnapshot(accessKey),
		[access, accessKey]
	)
	const accessRevoked = useSyncExternalStore(
		access.subscribe,
		accessSnapshot,
		accessSnapshot
	)
	const recoverySnapshot = useCallback(
		() => recovery.getSnapshot(accessKey),
		[recovery, accessKey]
	)
	const writeUnconfirmed = useSyncExternalStore(
		recovery.subscribe,
		recoverySnapshot,
		recoverySnapshot
	)
	const [draft, setDraft] = useState<string | null>(null)
	const [errorKey, setErrorKey] = useState<string | null>(null)
	const [saved, setSaved] = useState(false)
	const [refreshing, setRefreshing] = useState(false)
	const [readFailed, setReadFailed] = useState(false)
	const active = useRef(true)
	const revocationEpoch = useRef(0)
	const controller = useRef<AbortController | null>(null)
	const pendingValue = useRef<string | null>(null)
	const pendingRevision = useRef<AdminConfigRevision>(null)
	const overview = useQuery({
		queryKey,
		queryFn: ({ signal }) => props.api.configOverview({ signal }),
		enabled: !accessRevoked,
		retry: false,
		staleTime: 0,
		refetchOnWindowFocus: false,
	})
	const revoke = useCallback(
		(error: unknown): void => {
			if (!configAccessLost(error) && !configInvalidResponse(error)) return
			revocationEpoch.current += 1
			const firstDenial = access.block(accessKey)
			setDraft(null)
			setSaved(false)
			controller.current?.abort()
			void client.cancelQueries({ queryKey })
			client.removeQueries({ queryKey })
			if (configAccessLost(error) && firstDenial)
				void revalidate().catch(() => undefined)
		},
		[access, accessKey, client, queryKey, revalidate]
	)
	useEffect(
		() =>
			client.getQueryCache().subscribe((event) => {
				if (event.type !== 'updated' || event.action.type !== 'error') return
				if (event.query.queryKey.length !== queryKey.length) return
				if (
					!queryKey.every((part, index) => event.query.queryKey[index] === part)
				)
					return
				revoke(event.query.state.error)
			}),
		[client, queryKey, revoke]
	)
	useEffect(() => {
		active.current = true
		return () => {
			active.current = false
			controller.current?.abort()
			pendingValue.current = null
			pendingRevision.current = null
			void client.cancelQueries({ queryKey })
			client.removeQueries({ queryKey })
		}
	}, [client, queryKey])

	async function readFresh(allowRevoked = false): Promise<boolean> {
		const abort = new AbortController()
		const startingEpoch = revocationEpoch.current
		controller.current = abort
		try {
			await client.cancelQueries({ queryKey })
			const fresh = await props.api.configOverview({ signal: abort.signal })
			if (
				!active.current ||
				abort.signal.aborted ||
				revocationEpoch.current !== startingEpoch ||
				(accessRevoked && !allowRevoked)
			)
				return false
			client.setQueryData(queryKey, fresh)
			setDraft(null)
			setErrorKey(null)
			setReadFailed(false)
			return true
		} catch (error) {
			if (active.current && !abort.signal.aborted) {
				revoke(error)
				setErrorKey(configErrorKey(error))
				setReadFailed(true)
			}
			return false
		} finally {
			if (controller.current === abort) controller.current = null
		}
	}

	const mutation = useMutation<void, Error, void>({
		mutationKey: [...queryKey, 'timezone-write'],
		retry: false,
		gcTime: 0,
		mutationFn: async () => {
			const value = pendingValue.current
			if (value === null) return
			const expectedRevision = pendingRevision.current
			const abort = new AbortController()
			controller.current = abort
			let writeSucceeded = false
			try {
				await props.api.updateBusinessTimezone(value, expectedRevision, {
					signal: abort.signal,
				})
				writeSucceeded = true
				if (!active.current || abort.signal.aborted) return
				if (await readFresh()) {
					recovery.settle(accessKey)
					setSaved(true)
				}
			} catch (error) {
				if (active.current && !abort.signal.aborted) {
					revoke(error)
					if (
						typeof error === 'object' &&
						error !== null &&
						'status' in error &&
						error.status === 412
					)
						setReadFailed(true)
					if (!configWriteUncertain(error)) recovery.settle(accessKey)
					setErrorKey(configErrorKey(error))
				}
				throw error
			} finally {
				pendingValue.current = null
				pendingRevision.current = null
				if (controller.current === abort) controller.current = null
				if (!writeSucceeded && active.current) setSaved(false)
			}
		},
	})

	async function reconcile(): Promise<void> {
		if (refreshing || mutation.isPending) return
		setRefreshing(true)
		setSaved(false)
		try {
			if (await readFresh(accessRevoked)) {
				access.settle(accessKey)
				recovery.settle(accessKey)
			}
		} catch (error) {
			if (active.current) setErrorKey(configErrorKey(error))
		} finally {
			if (active.current) setRefreshing(false)
		}
	}

	function save(): void {
		if (
			accessRevoked ||
			readFailed ||
			writeUnconfirmed ||
			mutation.isPending ||
			refreshing ||
			!props.canWrite ||
			!overview.data?.canWrite ||
			overview.isFetching ||
			overview.error
		)
			return
		try {
			pendingValue.current = normalizeBusinessTimezoneWrite(
				draft ?? overview.data.businessTimezone.value
			)
			pendingRevision.current = overview.data.businessTimezone.revision
		} catch (error) {
			setErrorKey(configErrorKey(error))
			return
		}
		setSaved(false)
		setErrorKey(null)
		try {
			recovery.mark(accessKey)
		} catch (error) {
			pendingValue.current = null
			pendingRevision.current = null
			setErrorKey(configErrorKey(error))
			return
		}
		void mutation.mutateAsync().catch(() => undefined)
	}

	const hidden =
		accessRevoked ||
		readFailed ||
		Boolean(overview.error) ||
		overview.isFetching ||
		writeUnconfirmed
	const data = hidden ? null : overview.data
	const canSave =
		Boolean(data?.canWrite) &&
		props.canWrite &&
		!refreshing &&
		!mutation.isPending &&
		!writeUnconfirmed
	return (
		<main className='mx-auto w-full max-w-4xl min-w-0 space-y-6 px-4 py-6 sm:px-6'>
			<header className='space-y-2'>
				<h1 className='text-2xl font-semibold tracking-tight sm:text-3xl'>
					{t(prefix + 'title')}
				</h1>
				<p className='text-muted-foreground text-sm'>
					{t(prefix + 'subtitle')}
				</p>
				<p className='text-muted-foreground text-sm'>
					{t(prefix + 'incremental')}{' '}
					<a className='underline underline-offset-2' href='/admin/config'>
						{t(prefix + 'legacyLink')}
					</a>
				</p>
			</header>
			{writeUnconfirmed ? (
				<p
					role='alert'
					className='rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm'
				>
					{t(prefix + 'unconfirmed')}
				</p>
			) : null}
			{errorKey ? (
				<p
					role='alert'
					className='border-destructive/40 bg-destructive/10 rounded-lg border p-3 text-sm'
				>
					{t(errorKey)}
				</p>
			) : null}
			{saved ? (
				<p role='status' className='text-sm'>
					{t(prefix + 'saved')}
				</p>
			) : null}
			<Button
				type='button'
				variant='outline'
				onClick={() => void reconcile()}
				disabled={refreshing || mutation.isPending}
			>
				{t(prefix + 'refresh')}
			</Button>
			{!data ? (
				<p className='text-muted-foreground text-sm' role='status'>
					{overview.isFetching
						? t(prefix + 'loading')
						: t(prefix + 'unavailable')}
				</p>
			) : (
				<>
					<section
						className='bg-card space-y-4 rounded-xl border p-4 sm:p-5'
						aria-labelledby='config-timezone-title'
					>
						<div>
							<h2 id='config-timezone-title' className='font-semibold'>
								{t(prefix + 'timezone')}
							</h2>
							<p className='text-muted-foreground text-sm'>
								{t(prefix + 'timezoneHint')}
							</p>
						</div>
						<p className='text-sm'>
							{t(prefix + 'current')}: {data.businessTimezone.value} ·{' '}
							{t(prefix + sourceLabels[data.businessTimezone.source])}
						</p>
						{data.businessTimezone.source === 'legacy' ? (
							<p className='text-sm text-amber-700 dark:text-amber-400'>
								{t(prefix + 'legacyTimezone')}
							</p>
						) : null}
						<div className='flex flex-col gap-3 sm:flex-row sm:items-end'>
							<div className='min-w-0 flex-1 space-y-1'>
								<label
									className='text-sm font-medium'
									htmlFor='admin-business-timezone'
								>
									{t(prefix + 'newTimezone')}
								</label>
								<Input
									id='admin-business-timezone'
									value={draft ?? data.businessTimezone.value}
									onChange={(event) => {
										setDraft(event.target.value)
										setSaved(false)
									}}
									autoComplete='off'
									spellCheck={false}
									list='admin-timezone-suggestions'
									disabled={!canSave}
								/>
								<datalist id='admin-timezone-suggestions'>
									<option value='UTC' />
									<option value='Asia/Singapore' />
									<option value='Asia/Shanghai' />
									<option value='Europe/London' />
									<option value='America/New_York' />
								</datalist>
							</div>
							<Button type='button' onClick={save} disabled={!canSave}>
								{mutation.isPending
									? t(prefix + 'saving')
									: t(prefix + 'saveTimezone')}
							</Button>
						</div>
						{!data.canWrite || !props.canWrite ? (
							<p className='text-muted-foreground text-sm'>
								{t(prefix + 'readOnly')}
							</p>
						) : null}
					</section>
					<section
						className='grid gap-3 sm:grid-cols-2'
						aria-label={t(prefix + 'otherSettings')}
					>
						<article className='bg-card rounded-xl border p-4'>
							<h2 className='font-semibold'>{t(prefix + 'currency')}</h2>
							<p className='mt-2 text-sm'>
								{data.billingCurrency.value} ·{' '}
								{t(prefix + sourceLabels[data.billingCurrency.source])}
							</p>
							<p className='text-muted-foreground mt-2 text-xs'>
								{t(prefix + 'legacyManage')}
							</p>
						</article>
						<article className='bg-card rounded-xl border p-4'>
							<h2 className='font-semibold'>{t(prefix + 'strategy')}</h2>
							<p className='mt-2 text-sm break-words'>
								{data.routeStrategy.value} ·{' '}
								{t(prefix + sourceLabels[data.routeStrategy.source])}
							</p>
							<p className='text-muted-foreground mt-2 text-xs'>
								{t(prefix + 'legacyManage')}
							</p>
						</article>
						<article className='bg-card rounded-xl border p-4'>
							<h2 className='font-semibold'>{t(prefix + 'wecom')}</h2>
							<p className='mt-2 text-sm'>
								{t(
									prefix +
										(data.webhooks.wecom.configured
											? 'configured'
											: 'notConfigured')
								)}
							</p>
							<p className='text-muted-foreground mt-2 text-xs'>
								{t(prefix + 'legacyManage')}
							</p>
						</article>
						<article className='bg-card rounded-xl border p-4'>
							<h2 className='font-semibold'>{t(prefix + 'feishu')}</h2>
							<p className='mt-2 text-sm'>
								{t(
									prefix +
										(data.webhooks.feishu.configured
											? 'configured'
											: 'notConfigured')
								)}
							</p>
							<p className='text-muted-foreground mt-2 text-xs'>
								{t(prefix + 'legacyManage')}
							</p>
						</article>
					</section>
				</>
			)}
		</main>
	)
}
