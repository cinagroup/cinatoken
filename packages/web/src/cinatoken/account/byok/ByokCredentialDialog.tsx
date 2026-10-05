import { useQuery } from '@tanstack/react-query'
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
import { cinatokenApi } from '../../api'
import type { ByokKey } from '../../byok-contracts'
import { useCinaTokenSession } from '../../session-context'
import { isUserMismatch, requiresSessionRevalidation } from '../account-access'
import { formatAccountDate } from '../key-display'
import { ByokCredentialForm } from './ByokCredentialForm'
import { byokKeyForm, EMPTY_BYOK_FORM, type ByokForm } from './byok-form-schema'
import {
	byokQueryKey,
	type ByokScope,
	type ByokSelection,
} from './use-byok-manager'

type Props = {
	scope: ByokScope
	selected: ByokSelection | null
	defaultProvider: string
	isPending: boolean
	error: unknown
	onSubmit: (values: ByokForm, id?: string) => void
	onEdit: () => void
	onClose: () => void
}

function RestrictionDetail(props: { label: string; values: string[] | null }) {
	const { t } = useTranslation()
	let description = t('cinatoken.account.byok.any')
	if (props.values !== null) description = t('cinatoken.account.byok.noValues')
	return (
		<div className='space-y-2 border-t pt-3'>
			<dt className='text-muted-foreground text-xs'>{t(props.label)}</dt>
			<dd className='text-sm'>
				{props.values && props.values.length > 0 ? (
					<ul className='max-h-40 space-y-1 overflow-y-auto'>
						{props.values.map((value) => (
							<li key={value} className='font-mono text-xs break-all'>
								{value}
							</li>
						))}
					</ul>
				) : (
					description
				)}
			</dd>
		</div>
	)
}

function CredentialDetails(props: {
	row: ByokKey
	onEdit: () => void
	onClose: () => void
}) {
	const { t, i18n } = useTranslation()
	let policy = 'cinatoken.account.byok.allow'
	if (props.row.always_use_for_provider)
		policy = 'cinatoken.account.byok.providerPolicy'
	else if (props.row.always_use_for_matching_models)
		policy = 'cinatoken.account.byok.matching_models'
	return (
		<div className='space-y-5'>
			<p className='text-base font-semibold break-all'>
				{props.row.name || t('cinatoken.account.byok.unnamed')}
			</p>
			<div className='flex flex-wrap gap-2'>
				<Badge variant='outline'>{props.row.provider}</Badge>
				<Badge variant='secondary'>
					{t(
						props.row.is_fallback
							? 'cinatoken.account.byok.fallback'
							: 'cinatoken.account.byok.primary'
					)}
				</Badge>
				<Badge variant='outline'>
					{t(
						props.row.disabled
							? 'cinatoken.account.byok.disabled'
							: 'cinatoken.account.byok.enabled'
					)}
				</Badge>
			</div>
			<dl className='space-y-4'>
				<div>
					<dt className='text-muted-foreground text-xs'>
						{t('cinatoken.account.byok.maskedSecret')}
					</dt>
					<dd className='mt-1 font-mono'>{props.row.label}</dd>
				</div>
				<div>
					<dt className='text-muted-foreground text-xs'>
						{t('cinatoken.account.byok.identifier')}
					</dt>
					<dd className='mt-1 font-mono text-xs break-all'>{props.row.id}</dd>
				</div>
				<div>
					<dt className='text-muted-foreground text-xs'>
						{t('cinatoken.account.byok.createdAt')}
					</dt>
					<dd className='mt-1'>
						{formatAccountDate(
							props.row.created_at,
							i18n.resolvedLanguage ?? 'en'
						)}
					</dd>
				</div>
				<div>
					<dt className='text-muted-foreground text-xs'>
						{t('cinatoken.account.byok.sharedCapacity')}
					</dt>
					<dd className='mt-1'>{t(policy)}</dd>
				</div>
				<RestrictionDetail
					label='cinatoken.account.byok.models'
					values={props.row.allowed_models}
				/>
				<RestrictionDetail
					label='cinatoken.account.byok.users'
					values={props.row.allowed_user_ids}
				/>
				<RestrictionDetail
					label='cinatoken.account.byok.gatewayKeys'
					values={props.row.allowed_api_key_hashes}
				/>
			</dl>
			<div className='flex justify-end gap-2 border-t pt-4'>
				<Button variant='outline' onClick={props.onClose}>
					{t('cinatoken.account.byok.close')}
				</Button>
				<Button onClick={props.onEdit}>
					{t('cinatoken.account.byok.edit')}
				</Button>
			</div>
		</div>
	)
}

function ExistingCredential(props: Props & { selected: ByokSelection }) {
	const { t } = useTranslation()
	const session = useCinaTokenSession()
	const options = {
		expectedUserId: props.scope.userId,
		expectedWorkspaceId: props.scope.workspaceId,
		expectedManagementAccount: props.scope.account,
	}
	const query = useQuery({
		queryKey: byokQueryKey(props.scope, 'detail', props.selected.id, options),
		queryFn: ({ signal }) =>
			cinatokenApi.byokKey(props.selected.id, {
				...options,
				signal,
			}),
		retry: false,
		staleTime: 0,
		refetchOnWindowFocus: false,
	})
	if (query.isPending || query.isFetching)
		return (
			<Skeleton
				role='status'
				aria-label={t('cinatoken.account.byok.loading')}
				className='h-52'
			/>
		)
	if (query.isError)
		return (
			<div role='alert' className='space-y-4'>
				<p>
					{t(
						isUserMismatch(query.error)
							? 'cinatoken.account.sessionChanged'
							: 'cinatoken.account.byok.detailsFailed'
					)}
				</p>
				<Button
					variant='outline'
					onClick={() => {
						if (requiresSessionRevalidation(query.error))
							void session.revalidateScope()
						else void query.refetch()
					}}
				>
					{t('cinatoken.account.retry')}
				</Button>
				<Button variant='ghost' onClick={props.onClose}>
					{t('cinatoken.account.byok.close')}
				</Button>
			</div>
		)
	if (props.selected.mode === 'edit')
		return (
			<ByokCredentialForm
				key={query.data.id}
				defaultValues={byokKeyForm(query.data)}
				editing
				isPending={props.isPending}
				error={props.error}
				onClose={props.onClose}
				onSubmit={(values) => props.onSubmit(values, query.data.id)}
			/>
		)
	return (
		<CredentialDetails
			row={query.data}
			onEdit={props.onEdit}
			onClose={props.onClose}
		/>
	)
}

export function ByokCredentialDialog(props: Props) {
	const { t } = useTranslation()
	let title = 'cinatoken.account.byok.createTitle'
	if (props.selected)
		title =
			props.selected.mode === 'edit'
				? 'cinatoken.account.byok.editTitle'
				: 'cinatoken.account.byok.details'
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !props.isPending) props.onClose()
			}}
		>
			<DialogContent
				className='max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl'
				showCloseButton={false}
			>
				<DialogHeader>
					<DialogTitle>{t(title)}</DialogTitle>
					<DialogDescription>
						{t('cinatoken.account.byok.subtitle')}
					</DialogDescription>
				</DialogHeader>
				{props.selected ? (
					<ExistingCredential {...props} selected={props.selected} />
				) : (
					<ByokCredentialForm
						defaultValues={{
							...EMPTY_BYOK_FORM,
							provider: props.defaultProvider,
						}}
						editing={false}
						isPending={props.isPending}
						error={props.error}
						onSubmit={props.onSubmit}
						onClose={props.onClose}
					/>
				)}
			</DialogContent>
		</Dialog>
	)
}
