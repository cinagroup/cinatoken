import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { accountQueryKey, cinatokenApi, CinaTokenApiError } from '../../api'
import { useCinaTokenSession } from '../../session-context'
import {
	WORKSPACE_BUDGET_INTERVALS,
	type WorkspaceBudgetInterval,
} from '../../workspace-budget-contracts'
import {
	invalidatesAccountAccess,
	isWorkspaceMismatch,
	isUserMismatch,
	requiresSessionRevalidation,
} from '../account-access'
import { BudgetCard } from './BudgetCard'
import { parseBudgetDraft } from './budget-form'

const emptyDrafts = { daily: '', weekly: '', monthly: '', lifetime: '' }
type Operation = { interval: WorkspaceBudgetInterval; amount?: number }

function ScopedBudgets(props: {
	userId: string
	workspaceId: string
	version: number
}) {
	const { t } = useTranslation()
	const session = useCinaTokenSession()
	const client = useQueryClient()
	const key = accountQueryKey(
		props.userId,
		props.workspaceId,
		'workspace-budgets',
		props.version
	)
	const options = {
		expectedUserId: props.userId,
		expectedWorkspaceId: props.workspaceId,
	}
	const [drafts, setDrafts] = useState(emptyDrafts)
	const [invalid, setInvalid] = useState<WorkspaceBudgetInterval | null>(null)
	const [removing, setRemoving] = useState<WorkspaceBudgetInterval | null>(null)
	const [notice, setNotice] = useState<string | null>(null)
	const active = useRef(false)
	const controllers = useRef(new Set<AbortController>())
	const query = useQuery({
		queryKey: key,
		queryFn: ({ signal }) =>
			cinatokenApi.workspaceBudgets({
				expectedUserId: props.userId,
				expectedWorkspaceId: props.workspaceId,
				signal,
			}),
		retry: false,
	})
	useEffect(() => {
		active.current = true
		const pending = controllers.current
		return () => {
			active.current = false
			for (const controller of pending) controller.abort()
			pending.clear()
		}
	}, [])
	useEffect(
		() =>
			client.getQueryCache().subscribe((event) => {
				if (
					event.type !== 'updated' ||
					event.action.type !== 'error' ||
					!invalidatesAccountAccess(event.query.state.error)
				)
					return
				if (key.every((part, index) => event.query.queryKey[index] === part)) {
					setRemoving(null)
					setDrafts(emptyDrafts)
					for (const controller of controllers.current) controller.abort()
				}
			}),
		[client, key]
	)
	const mutation = useMutation({
		mutationKey: [...key, 'change'],
		retry: false,
		gcTime: 0,
		mutationFn: async (operation: Operation): Promise<void> => {
			const controller = new AbortController()
			controllers.current.add(controller)
			try {
				if (operation.amount === undefined)
					await cinatokenApi.deleteWorkspaceBudget(operation.interval, {
						...options,
						signal: controller.signal,
					})
				else
					await cinatokenApi.setWorkspaceBudget(
						operation.interval,
						{ limit_usd: operation.amount },
						{ ...options, signal: controller.signal }
					)
				if (!active.current || controller.signal.aborted) return
				setRemoving(null)
				setDrafts((current) => ({ ...current, [operation.interval]: '' }))
				setNotice(operation.amount === undefined ? 'removed' : 'saved')
			} finally {
				controllers.current.delete(controller)
			}
		},
		onSuccess: async () => {
			if (active.current) await client.invalidateQueries({ queryKey: key })
		},
		onError: (error) => {
			if (active.current && invalidatesAccountAccess(error)) {
				setRemoving(null)
				setDrafts(emptyDrafts)
			}
		},
	})
	const errors = [query.error, mutation.error]
	const blocked = errors.some(invalidatesAccountAccess)
	const pending = mutation.isPending || query.isFetching
	const canManage = query.isSuccess && query.data.canManage && !blocked
	const retry = () => {
		const needsContext = errors.some(requiresSessionRevalidation)
		setRemoving(null)
		setNotice(null)
		mutation.reset()
		if (needsContext) void session.revalidateScope()
		else void query.refetch()
	}
	const save = (interval: WorkspaceBudgetInterval) => {
		if (!canManage || pending) return
		const amount = parseBudgetDraft(drafts[interval])
		if (amount === null) {
			setInvalid(interval)
			return
		}
		setInvalid(null)
		setNotice(null)
		mutation.reset()
		mutation.mutate({ interval, amount })
	}
	let errorKey = 'cinatoken.workspaceBudgets.failed'
	if (errors.some(isUserMismatch)) errorKey = 'cinatoken.account.sessionChanged'
	else if (errors.some(isWorkspaceMismatch))
		errorKey = 'cinatoken.shell.workspaceChanged'
	else if (blocked) errorKey = 'cinatoken.workspaceBudgets.denied'
	else if (
		mutation.error instanceof CinaTokenApiError &&
		mutation.error.status === 400
	)
		errorKey = 'cinatoken.workspaceBudgets.rejected'
	else if (query.isError) errorKey = 'cinatoken.workspaceBudgets.loadFailed'
	return (
		<section
			className='space-y-4 rounded-xl border p-4 sm:p-5'
			aria-labelledby='workspace-budgets-title'
		>
			<header className='flex flex-wrap items-start justify-between gap-3'>
				<div className='min-w-0 flex-1 basis-60'>
					<h2 id='workspace-budgets-title' className='text-lg font-semibold'>
						{t('cinatoken.workspaceBudgets.title')}
					</h2>
					<p className='text-muted-foreground mt-1 max-w-3xl text-sm'>
						{t('cinatoken.workspaceBudgets.subtitle')}
					</p>
				</div>
				{query.isSuccess && !blocked && (
					<Badge variant='outline'>
						{t(
							query.data.canManage
								? 'cinatoken.workspaceBudgets.editable'
								: 'cinatoken.workspaceBudgets.readOnly'
						)}
					</Badge>
				)}
				<Button variant='outline' size='sm' disabled={pending} onClick={retry}>
					{t('cinatoken.account.refresh')}
				</Button>
			</header>
			{(query.isError || mutation.isError) && (
				<Alert variant='destructive'>
					<AlertDescription>{t(errorKey)}</AlertDescription>
					<Button
						className='mt-2 w-fit'
						size='sm'
						variant='outline'
						disabled={pending}
						onClick={retry}
					>
						{t('cinatoken.account.retry')}
					</Button>
				</Alert>
			)}
			{notice && (
				<p role='status' className='bg-muted/40 rounded-lg border p-3 text-sm'>
					{t('cinatoken.workspaceBudgets.' + notice)}
				</p>
			)}
			{query.isPending && (
				<div role='status' aria-label={t('cinatoken.workspaceBudgets.loading')}>
					<Skeleton className='h-48' />
				</div>
			)}
			{query.data && !blocked && (
				<div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-4'>
					{WORKSPACE_BUDGET_INTERVALS.map((interval) => (
						<BudgetCard
							key={interval}
							interval={interval}
							row={query.data.budgets.find(
								(row) => row.resetInterval === interval
							)}
							currency={query.data.billingCurrency}
							canManage={canManage}
							pending={pending}
							draft={drafts[interval]}
							invalid={invalid === interval}
							onDraft={(value) => {
								setInvalid(null)
								setDrafts((current) => ({ ...current, [interval]: value }))
							}}
							onSave={() => save(interval)}
							onRemove={() => {
								if (canManage && !pending) {
									mutation.reset()
									setNotice(null)
									setRemoving(interval)
								}
							}}
						/>
					))}
				</div>
			)}
			<p className='text-muted-foreground text-xs leading-5'>
				{t('cinatoken.workspaceBudgets.ordering')}
			</p>
			{removing && canManage && (
				<Dialog
					open
					onOpenChange={(open) => {
						if (!open) setRemoving(null)
					}}
				>
					<DialogContent showCloseButton={!mutation.isPending}>
						<DialogHeader>
							<DialogTitle>
								{t('cinatoken.workspaceBudgets.removeTitle', {
									interval: t(
										'cinatoken.workspaceBudgets.intervals.' + removing
									),
								})}
							</DialogTitle>
							<DialogDescription>
								{t('cinatoken.workspaceBudgets.removeNotice')}
							</DialogDescription>
						</DialogHeader>
						<div className='flex flex-wrap justify-end gap-2'>
							<Button
								variant='outline'
								disabled={mutation.isPending}
								onClick={() => setRemoving(null)}
							>
								{t('cinatoken.account.cancel')}
							</Button>
							<Button
								variant='destructive'
								disabled={mutation.isPending}
								onClick={() => {
									if (canManage && !pending) {
										setNotice(null)
										mutation.mutate({ interval: removing })
									}
								}}
							>
								{t('cinatoken.workspaceBudgets.remove')}
							</Button>
						</div>
					</DialogContent>
				</Dialog>
			)}
		</section>
	)
}

export function WorkspaceBudgetManager() {
	const session = useCinaTokenSession()
	if (
		session.status !== 'authenticated' ||
		!session.user ||
		!session.workspaceContext ||
		session.isSwitchingWorkspace ||
		session.isLoggingOut
	)
		return null
	const workspace = session.workspaceContext.currentWorkspace
	return (
		<ScopedBudgets
			key={`${session.user.userId}:${workspace.id}:${session.scopeVersion}`}
			userId={session.user.userId}
			workspaceId={workspace.id}
			version={session.scopeVersion}
		/>
	)
}
