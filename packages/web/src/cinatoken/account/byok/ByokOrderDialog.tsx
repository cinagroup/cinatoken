import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'
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
import { cinatokenApi, CinaTokenApiError } from '../../api'
import type { ByokKey } from '../../byok-contracts'
import { invalidatesAccountAccess } from '../account-access'
import {
	completeByokGroup,
	moveByokKey,
	orderedByokKeys,
} from './byok-form-schema'
import { byokErrorKey, byokQueryKey, type ByokScope } from './use-byok-manager'

export function ByokOrderDialog(props: {
	scope: ByokScope
	provider: string
	onClose: () => void
	onSaved: () => void
	onAccessLost: (error: unknown) => void
}) {
	const { t } = useTranslation()
	const active = useRef(false)
	const request = useRef<AbortController | null>(null)
	const [draft, setDraft] = useState<ByokKey[] | null>(null)
	const [requiresReload, setRequiresReload] = useState(false)
	const options = {
		expectedUserId: props.scope.userId,
		expectedWorkspaceId: props.scope.workspaceId,
		expectedManagementAccount: props.scope.account,
	}
	const query = useQuery({
		queryKey: byokQueryKey(
			props.scope,
			'provider-group',
			props.provider,
			options
		),
		queryFn: async ({ signal }) => {
			const page = await cinatokenApi.byokKeys({
				...options,
				provider: props.provider,
				offset: 0,
				limit: 100,
				signal,
			})
			return orderedByokKeys(
				completeByokGroup(
					page.data,
					page.total,
					options.expectedWorkspaceId,
					props.provider
				)
			)
		},
		retry: false,
		staleTime: 0,
		refetchOnWindowFocus: false,
	})
	useEffect(() => {
		active.current = true
		return () => {
			active.current = false
			request.current?.abort()
		}
	}, [])
	const rows = draft ?? query.data ?? []
	const changed =
		draft !== null &&
		draft.some((row, index) => row.id !== query.data?.[index]?.id)
	const mutation = useMutation({
		mutationKey: byokQueryKey(props.scope, 'reorder'),
		retry: false,
		gcTime: 0,
		mutationFn: async (): Promise<void> => {
			const controller = new AbortController()
			request.current = controller
			try {
				const group = completeByokGroup(
					rows,
					query.data?.length ?? 0,
					props.scope.workspaceId,
					props.provider
				)
				await cinatokenApi.reorderByokKeys(
					{
						workspace_id: props.scope.workspaceId,
						provider: props.provider,
						keys: group.map((row) => ({
							id: row.id,
							is_fallback: row.is_fallback,
						})),
					},
					{ ...options, signal: controller.signal }
				)
			} finally {
				request.current = null
			}
		},
		onSuccess: () => {
			if (active.current) props.onSaved()
		},
		onError: (error) => {
			if (!active.current) return
			if (invalidatesAccountAccess(error)) {
				setDraft(null)
				props.onAccessLost(error)
				return
			}
			if (
				error instanceof CinaTokenApiError &&
				(error.status === 409 || error.status === 404)
			) {
				setDraft(null)
				setRequiresReload(true)
			}
		},
	})
	const reload = async () => {
		mutation.reset()
		setDraft(null)
		const result = await query.refetch()
		if (active.current) setRequiresReload(!result.isSuccess)
	}
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !mutation.isPending) props.onClose()
			}}
		>
			<DialogContent
				className='max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl'
				showCloseButton={false}
			>
				<DialogHeader>
					<DialogTitle>
						{t('cinatoken.account.byok.reorderTitle', {
							provider: props.provider,
						})}
					</DialogTitle>
					<DialogDescription>
						{t('cinatoken.account.byok.reorderHint')}
					</DialogDescription>
				</DialogHeader>
				{query.isPending || query.isFetching ? (
					<Skeleton
						role='status'
						aria-label={t('cinatoken.account.byok.loading')}
						className='h-48'
					/>
				) : null}
				{query.isError && (
					<p role='alert' className='text-destructive'>
						{t('cinatoken.account.byok.incompleteGroup')}
					</p>
				)}
				{query.isSuccess && !query.isFetching && (
					<ol className='space-y-2'>
						{rows.map((row, index) => {
							const name = row.name || row.label
							const disabled = mutation.isPending || requiresReload
							return (
								<li
									key={row.id}
									className='flex items-center gap-3 rounded-lg border p-3'
								>
									<span className='text-muted-foreground w-5 text-xs tabular-nums'>
										{index + 1}
									</span>
									<div className='min-w-0 flex-1'>
										<p className='font-medium break-all'>{name}</p>
										<code className='text-muted-foreground text-xs'>
											{row.label}
										</code>
										<div className='mt-1 flex flex-wrap gap-1'>
											<Badge variant='outline'>
												{t(
													row.is_fallback
														? 'cinatoken.account.byok.fallback'
														: 'cinatoken.account.byok.primary'
												)}
											</Badge>
											{row.disabled && (
												<Badge variant='secondary'>
													{t('cinatoken.account.byok.disabled')}
												</Badge>
											)}
										</div>
									</div>
									<div className='flex shrink-0 gap-1'>
										<Button
											variant='outline'
											size='icon-sm'
											aria-label={t('cinatoken.account.byok.up', { name })}
											disabled={
												disabled ||
												index === 0 ||
												rows[index - 1].is_fallback !== row.is_fallback
											}
											onClick={() => setDraft(moveByokKey(rows, row.id, -1))}
										>
											<ArrowUp aria-hidden='true' />
										</Button>
										<Button
											variant='outline'
											size='icon-sm'
											aria-label={t('cinatoken.account.byok.down', { name })}
											disabled={
												disabled ||
												index === rows.length - 1 ||
												rows[index + 1].is_fallback !== row.is_fallback
											}
											onClick={() => setDraft(moveByokKey(rows, row.id, 1))}
										>
											<ArrowDown aria-hidden='true' />
										</Button>
									</div>
								</li>
							)
						})}
					</ol>
				)}
				{mutation.isError && (
					<p role='alert' className='text-destructive text-sm'>
						{t(byokErrorKey(mutation.error))}
					</p>
				)}
				<div className='flex flex-wrap justify-end gap-2 border-t pt-4'>
					<Button
						variant='outline'
						disabled={mutation.isPending}
						onClick={props.onClose}
					>
						{t('cinatoken.account.cancel')}
					</Button>
					<Button
						variant='outline'
						disabled={query.isFetching || mutation.isPending}
						onClick={() => void reload()}
					>
						{t('cinatoken.account.byok.reloadGroup')}
					</Button>
					<Button
						disabled={
							!changed ||
							!query.isSuccess ||
							query.isFetching ||
							mutation.isPending ||
							requiresReload
						}
						onClick={() => mutation.mutate()}
					>
						{t(
							mutation.isPending
								? 'cinatoken.account.byok.saving'
								: 'cinatoken.account.byok.saveOrder'
						)}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	)
}
