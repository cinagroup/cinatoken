import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cinatokenApi, accountQueryKey } from '../api'
import type { GatewayKey } from '../contracts'
import { useCinaTokenSession } from '../session-context'
import { AccountLoading } from './AccountLoading'
import { AccountManagementKeys } from './AccountManagementKeys'
import { KeyCreateDialog } from './KeyCreateDialog'
import { KeyList } from './KeyList'
import { OneTimeKeyDialog } from './OneTimeKeyDialog'
import { RevokeKeyDialog } from './RevokeKeyDialog'
import {
	invalidatesAccountAccess,
	isWorkspaceMismatch,
	isUserMismatch,
	requiresSessionRevalidation,
} from './account-access'
import { createKeyInput, type CreateKeyForm } from './key-form-schema'
import { AccountSharedKeys } from './shared-keys/AccountSharedKeys'
import { useGatewayKeys } from './use-gateway-keys'

type ScopedKeysProps = {
	userId: string
	workspaceId: string
	workspaceName: string
	headingLevel?: 'h1' | 'h2'
}

export function GatewayKeysSection(props: ScopedKeysProps) {
	const { t } = useTranslation()
	const session = useCinaTokenSession()
	const queryClient = useQueryClient()
	const query = useGatewayKeys(props.userId, props.workspaceId)
	const Heading = props.headingLevel ?? 'h1'
	const [createOpen, setCreateOpen] = useState(false)
	const [secret, setSecret] = useState<string | null>(null)
	const [revokeKey, setRevokeKey] = useState<GatewayKey | null>(null)
	const controllers = useRef(new Set<AbortController>())
	const active = useRef(false)
	const clearSensitive = () => {
		setSecret(null)
		setCreateOpen(false)
		setRevokeKey(null)
		for (const controller of controllers.current) controller.abort()
	}

	useEffect(() => {
		active.current = true
		const pending = controllers.current
		return () => {
			active.current = false
			for (const controller of pending) controller.abort()
			pending.clear()
		}
	}, [])

	const invalidate = () =>
		queryClient.invalidateQueries({
			queryKey: accountQueryKey(
				props.userId,
				props.workspaceId,
				'gateway-keys'
			),
		})
	const create = useMutation({
		mutationKey: accountQueryKey(
			props.userId,
			props.workspaceId,
			'create-gateway-key'
		),
		retry: false,
		gcTime: 0,
		mutationFn: async (values: CreateKeyForm): Promise<void> => {
			const controller = new AbortController()
			controllers.current.add(controller)
			try {
				const created = await cinatokenApi.createGatewayKey(
					createKeyInput(values),
					{
						signal: controller.signal,
						expectedUserId: props.userId,
						expectedWorkspaceId: props.workspaceId,
					}
				)
				if (!active.current || controller.signal.aborted) return
				if (created.workspace_id !== props.workspaceId)
					throw new Error('Workspace changed while creating the key.')
				// Return no data: the plaintext must never enter TanStack's mutation cache.
				setSecret(created.key)
				setCreateOpen(false)
			} finally {
				controllers.current.delete(controller)
			}
		},
		onSuccess: () => {
			if (active.current) void invalidate()
		},
		onError: (error) => {
			if (active.current && invalidatesAccountAccess(error)) clearSensitive()
		},
	})
	const revoke = useMutation({
		mutationKey: accountQueryKey(
			props.userId,
			props.workspaceId,
			'revoke-gateway-key'
		),
		retry: false,
		gcTime: 0,
		mutationFn: async (key: GatewayKey): Promise<void> => {
			if (key.workspaceId !== props.workspaceId)
				throw new Error('Key does not belong to this workspace.')
			const controller = new AbortController()
			controllers.current.add(controller)
			try {
				await cinatokenApi.revokeGatewayKey(key.id, {
					signal: controller.signal,
					expectedUserId: props.userId,
					expectedWorkspaceId: props.workspaceId,
				})
				if (!active.current || controller.signal.aborted) return
				setRevokeKey(null)
			} finally {
				controllers.current.delete(controller)
			}
		},
		onSuccess: () => {
			if (active.current) void invalidate()
		},
		onError: (error) => {
			if (active.current && invalidatesAccountAccess(error)) clearSensitive()
		},
	})
	useEffect(
		() =>
			queryClient.getQueryCache().subscribe((event) => {
				if (
					event.type !== 'updated' ||
					event.action.type !== 'error' ||
					!invalidatesAccountAccess(event.query.state.error)
				)
					return
				const key = accountQueryKey(
					props.userId,
					props.workspaceId,
					'gateway-keys'
				)
				if (key.every((part, index) => event.query.queryKey[index] === part)) {
					setSecret(null)
					setCreateOpen(false)
					setRevokeKey(null)
					for (const controller of controllers.current) controller.abort()
				}
			}),
		[queryClient, props.userId, props.workspaceId]
	)
	const errors = [query.error, create.error, revoke.error]
	const accessLost = errors.some(invalidatesAccountAccess)
	const contextMismatch = errors.some(isWorkspaceMismatch)
	const userMismatch = errors.some(isUserMismatch)
	const retryAccess = () => {
		const revalidate = errors.some(requiresSessionRevalidation)
		clearSensitive()
		create.reset()
		revoke.reset()
		if (revalidate) void session.revalidateScope()
		else void query.refetch()
	}
	const isPending = create.isPending || revoke.isPending
	const openCreate = () => {
		if (!query.isSuccess || accessLost) return
		create.reset()
		setSecret(null)
		setCreateOpen(true)
	}
	const openRevoke = (key: GatewayKey) => {
		if (accessLost || !query.isSuccess) return
		revoke.reset()
		setRevokeKey(key)
	}

	return (
		<div className='space-y-6'>
			<header className='flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between'>
				<div className='space-y-2'>
					<Badge variant='outline'>{props.workspaceName}</Badge>
					<Heading className='text-2xl font-semibold tracking-tight sm:text-3xl'>
						{t('cinatoken.account.keys.title')}
					</Heading>
					<p className='text-muted-foreground max-w-2xl text-sm'>
						{t('cinatoken.account.keys.description')}
					</p>
				</div>
				<div className='flex shrink-0 gap-2'>
					<Button
						variant='outline'
						size='icon'
						disabled={query.isFetching || isPending}
						onClick={retryAccess}
						aria-label={t('cinatoken.account.refresh')}
					>
						<RefreshCw
							aria-hidden='true'
							className={query.isFetching ? 'animate-spin' : ''}
						/>
					</Button>
					<Button
						disabled={isPending || !query.isSuccess || accessLost}
						onClick={openCreate}
					>
						<Plus aria-hidden='true' />
						{t('cinatoken.account.keys.create')}
					</Button>
				</div>
			</header>
			<div className='bg-muted/30 text-muted-foreground rounded-xl border px-4 py-3 text-sm'>
				{t('cinatoken.account.keys.scopeNotice')}
			</div>
			{query.isPending && <AccountLoading />}
			{(query.isError || accessLost) && (
				<Alert variant='destructive'>
					<AlertTitle>{t('cinatoken.account.keys.loadFailed')}</AlertTitle>
					<AlertDescription>
						{t(
							userMismatch
								? 'cinatoken.account.sessionChanged'
								: contextMismatch
									? 'cinatoken.shell.workspaceChanged'
									: 'cinatoken.account.retryHint'
						)}
					</AlertDescription>
					<Button
						variant='outline'
						className='mt-2 w-fit'
						disabled={query.isFetching}
						onClick={retryAccess}
					>
						{t('cinatoken.account.retry')}
					</Button>
				</Alert>
			)}
			{query.isSuccess && !accessLost && (
				<KeyList
					keys={query.data.keys}
					billingCurrency={query.data.billingCurrency}
					isPending={isPending}
					onCreate={openCreate}
					onRevoke={openRevoke}
				/>
			)}
			{createOpen && query.data && !accessLost && (
				<KeyCreateDialog
					workspaceName={props.workspaceName}
					billingCurrency={query.data.billingCurrency}
					isPending={create.isPending}
					error={create.isError}
					onClose={() => setCreateOpen(false)}
					onSubmit={(values) => create.mutate(values)}
				/>
			)}
			{secret && !accessLost && (
				<OneTimeKeyDialog secret={secret} onClose={() => setSecret(null)} />
			)}
			{revokeKey && !accessLost && (
				<RevokeKeyDialog
					gatewayKey={revokeKey}
					isPending={revoke.isPending}
					error={revoke.isError}
					onClose={() => setRevokeKey(null)}
					onConfirm={() => revoke.mutate(revokeKey)}
				/>
			)}
		</div>
	)
}

export function AccountKeys() {
	const { t } = useTranslation()
	const session = useCinaTokenSession()
	if (
		session.status === 'loading' ||
		session.isSwitchingWorkspace ||
		session.isLoggingOut
	)
		return <AccountLoading />
	if (
		session.status !== 'authenticated' ||
		!session.user ||
		!session.workspaceContext
	)
		return null
	const workspace = session.workspaceContext.currentWorkspace
	return (
		<div className='space-y-8'>
			{session.user.capabilities.includes('gateway_keys.manage') ? (
				<GatewayKeysSection
					key={`${session.user.userId}:${workspace.id}:${session.scopeVersion}`}
					userId={session.user.userId}
					workspaceId={workspace.id}
					workspaceName={workspace.name}
				/>
			) : (
				<Alert>
					<AlertTitle>{t('cinatoken.account.accessDenied')}</AlertTitle>
					<AlertDescription>
						{t('cinatoken.account.keys.noAccess')}
					</AlertDescription>
				</Alert>
			)}
			<AccountManagementKeys />
			<AccountSharedKeys />
		</div>
	)
}
