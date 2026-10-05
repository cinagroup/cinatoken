import { useState } from 'react'
import { Plus, RefreshCw, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { useCinaTokenSession } from '../../session-context'
import { EffectiveGuardrails } from './EffectiveGuardrails'
import { GuardrailDetails } from './GuardrailDetails'
import { GuardrailEditor, type GuardrailEditorState } from './GuardrailEditor'
import {
	guardrailErrorKey,
	useGuardrailsManager,
	type GuardrailAction,
	type GuardrailScope,
	type GuardrailsAccountApi,
} from './use-guardrails-manager'

function ScopedGuardrails(props: {
	api: GuardrailsAccountApi
	scope: GuardrailScope
	workspaceName: string
}) {
	const { t } = useTranslation()
	const manager = useGuardrailsManager(props.api, props.scope)
	const [editor, setEditor] = useState<GuardrailEditorState | null>(null)
	const [confirmation, setConfirmation] = useState<{
		action: GuardrailAction
		label: string
	} | null>(null)
	const text = (key: string) => t(`cinatoken.account.guardrails.${key}`)
	const snapshot =
		!manager.blocked && !manager.list.isError ? manager.list.data : null
	const canInspect = Boolean(snapshot)
	const editingRow = editor?.row
		? snapshot?.guardrails.find((row) => row.id === editor.row?.id)
		: undefined
	const visibleEditor =
		editor && canInspect && (!editor.row || editingRow?.canEdit)
	function confirm(action: GuardrailAction, label: string) {
		setConfirmation({ action, label })
	}
	return (
		<div className='space-y-5'>
			<div className='flex flex-wrap items-center justify-between gap-3'>
				<Badge variant='outline'>
					{t('cinatoken.account.guardrails.workspaceScope', {
						name: props.workspaceName,
					})}
				</Badge>
				<div className='flex gap-2'>
					<Button
						variant='outline'
						disabled={
							manager.pending ||
							manager.list.isFetching ||
							manager.preview.isFetching
						}
						onClick={() => void manager.refresh()}
					>
						<RefreshCw aria-hidden='true' />
						{text('refresh')}
					</Button>
					<Button
						disabled={!manager.canWrite}
						onClick={() =>
							setEditor({ row: null, config: {}, metadataOnly: false })
						}
					>
						<Plus aria-hidden='true' />
						{text('create')}
					</Button>
				</div>
			</div>
			{manager.list.isPending ? (
				<div role='status' className='space-y-3'>
					<p className='text-muted-foreground text-sm'>{text('loading')}</p>
					<Skeleton className='h-28' />
					<Skeleton className='h-28' />
				</div>
			) : null}
			{manager.list.isError || manager.blocked ? (
				<Alert variant='destructive'>
					<AlertDescription>
						{text(manager.blocked ?? 'loadFailed')}{' '}
						<Button variant='link' onClick={() => void manager.refresh()}>
							{text('retry')}
						</Button>
					</AlertDescription>
				</Alert>
			) : null}
			{manager.keys.isError && !manager.blocked ? (
				<Alert variant='destructive'>
					<AlertDescription>
						{text('keyAccessUnavailable')}{' '}
						<Button variant='link' onClick={() => void manager.refresh()}>
							{text('retry')}
						</Button>
					</AlertDescription>
				</Alert>
			) : null}
			{manager.notice ? (
				<p role='status' className='bg-muted rounded-lg border p-3 text-sm'>
					{text('success')}
				</p>
			) : null}
			{manager.error ? (
				<Alert variant='destructive'>
					<AlertDescription>
						{text(guardrailErrorKey(manager.error))}
					</AlertDescription>
				</Alert>
			) : null}
			{snapshot?.guardrails.length === 0 ? (
				<Card>
					<CardContent className='flex flex-col items-center gap-3 py-10 text-center'>
						<ShieldCheck
							aria-hidden='true'
							className='text-muted-foreground size-9'
						/>
						<p>{text('empty')}</p>
					</CardContent>
				</Card>
			) : null}
			{snapshot?.guardrails.map((row) => (
				<Card key={row.id}>
					<CardContent className='space-y-4 py-5'>
						<div className='flex flex-wrap items-start justify-between gap-3'>
							<div className='min-w-0 space-y-2'>
								<h2 className='text-lg font-semibold break-words'>
									{row.name}
								</h2>
								<p className='text-muted-foreground text-sm break-words'>
									{row.description || text('noDescription')}
								</p>
							</div>
							<div className='flex flex-wrap gap-2'>
								<Badge
									variant={row.status === 'active' ? 'default' : 'secondary'}
								>
									{text(row.status)}
								</Badge>
								{row.isAccountDefault ? (
									<Badge variant='outline'>{text('accountDefaultBadge')}</Badge>
								) : null}
								{row.isWorkspaceDefault ? (
									<Badge variant='outline'>{text('defaultBadge')}</Badge>
								) : null}
								{row.adminManaged ? (
									<Badge variant='secondary'>{text('managed')}</Badge>
								) : null}
							</div>
						</div>
						<p className='text-muted-foreground text-xs'>
							{text('designated')}: v{row.designatedVersion} ·{' '}
							{text('versions')}: {row.latestVersion}
						</p>
						{row.config === null ? (
							<p className='text-destructive text-sm'>
								{text('configUnavailable')}
							</p>
						) : null}
						{row.isAccountDefault ? (
							<p className='text-muted-foreground text-sm'>
								{text('implicitAccountDefault')}
							</p>
						) : null}
						{row.isWorkspaceDefault ? (
							<p className='text-muted-foreground text-sm'>
								{text('implicitDefault')}
							</p>
						) : null}
						<div className='flex flex-wrap gap-2'>
							<Button
								variant='outline'
								size='sm'
								disabled={manager.pending}
								onClick={() => manager.setSelectedId(row.id)}
							>
								{text('details')}
							</Button>
							{row.canEdit ? (
								<>
									<Button
										variant='outline'
										size='sm'
										disabled={!manager.canWrite}
										onClick={() =>
											setEditor({
												row,
												config: row.config ?? {},
												metadataOnly: false,
											})
										}
									>
										{text('newVersion')}
									</Button>
									<Button
										variant='outline'
										size='sm'
										disabled={!manager.canWrite}
										onClick={() =>
											setEditor({
												row,
												config: row.config ?? {},
												metadataOnly: true,
											})
										}
									>
										{text('editMetadata')}
									</Button>
								</>
							) : (
								<Badge variant='secondary'>{text('readonly')}</Badge>
							)}
							{row.canArchive ? (
								<Button
									variant='outline'
									size='sm'
									disabled={!manager.canWrite}
									onClick={() =>
										confirm(
											{ type: 'archive', id: row.id },
											text('confirmArchive')
										)
									}
								>
									{text('archive')}
								</Button>
							) : null}
							{row.canRestore ? (
								<Button
									variant='outline'
									size='sm'
									disabled={!manager.canWrite}
									onClick={() =>
										confirm(
											{ type: 'restore', id: row.id },
											text('confirmRestore')
										)
									}
								>
									{text('restore')}
								</Button>
							) : null}
						</div>
					</CardContent>
				</Card>
			))}
			{manager.selectedId && canInspect ? (
				<GuardrailDetails
					key={manager.selectedId}
					manager={manager}
					userId={props.scope.userId}
					onEdit={setEditor}
					onConfirm={confirm}
				/>
			) : null}
			<EffectiveGuardrails manager={manager} />
			{visibleEditor && editor ? (
				<GuardrailEditor
					editor={{ ...editor, row: editingRow ?? null }}
					manager={manager}
					currency={snapshot?.budgetCurrency ?? 'USD'}
					onClose={() => setEditor(null)}
				/>
			) : null}
			{confirmation && canInspect ? (
				<Dialog
					open
					onOpenChange={(open) => {
						if (!open && !manager.pending) setConfirmation(null)
					}}
				>
					<DialogContent showCloseButton={!manager.pending}>
						<DialogHeader>
							<DialogTitle>{text('confirmChange')}</DialogTitle>
							<DialogDescription>{text('confirmHint')}</DialogDescription>
						</DialogHeader>
						<p className='text-sm break-words'>{confirmation.label}</p>
						<DialogFooter>
							<Button
								variant='outline'
								disabled={manager.pending}
								onClick={() => setConfirmation(null)}
							>
								{text('cancel')}
							</Button>
							<Button
								disabled={!manager.canWrite}
								onClick={() =>
									void manager.mutate(confirmation.action).then(() => {
										setConfirmation(null)
									})
								}
							>
								{text(manager.pending ? 'pending' : 'confirm')}
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			) : null}
		</div>
	)
}
export function AccountGuardrails(props: { api: GuardrailsAccountApi }) {
	const { t } = useTranslation()
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
	let accountScopeKey: string | null = null
	if (workspace.scopeType === 'personal' && workspace.personalOwnerUserId)
		accountScopeKey = `personal:${workspace.personalOwnerUserId}`
	if (workspace.scopeType === 'organization' && workspace.organizationId)
		accountScopeKey = `organization:${workspace.organizationId}`
	return (
		<section aria-labelledby='guardrails-title' className='space-y-6'>
			<header className='space-y-2'>
				<h1
					id='guardrails-title'
					className='text-2xl font-semibold tracking-tight'
				>
					{t('cinatoken.account.guardrails.title')}
				</h1>
				<p className='text-muted-foreground max-w-3xl text-sm leading-6'>
					{t('cinatoken.account.guardrails.subtitle')}
				</p>
			</header>
			{session.user.capabilities.includes('account.read') && accountScopeKey ? (
				<ScopedGuardrails
					key={`${session.user.userId}:${workspace.id}:${session.scopeVersion}`}
					api={props.api}
					workspaceName={workspace.name}
					scope={{
						userId: session.user.userId,
						workspaceId: workspace.id,
						accountScopeKey,
						scopeVersion: session.scopeVersion,
						canManageGatewayKeys: session.user.capabilities.includes(
							'gateway_keys.manage'
						),
					}}
				/>
			) : (
				<Alert>
					<AlertDescription>
						{t('cinatoken.account.guardrails.noCapability')}
					</AlertDescription>
				</Alert>
			)}
		</section>
	)
}
