import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useCinaTokenSession } from '../../session-context'
import type { WalletApi } from '../../wallet-api'
import type { WithdrawalsApi } from '../../withdrawal-api'
import { hasActiveWithdrawal } from '../../withdrawal-contracts'
import { WithdrawalHistory } from './WithdrawalHistory'
import {
	useWithdrawManager,
	withdrawalErrorKey,
	type WithdrawalScope,
} from './use-withdraw-manager'
import { withdrawalFormSchema, type WithdrawalForm } from './withdrawal-form'

function ScopedWithdraw(props: {
	api: WalletApi & WithdrawalsApi
	scope: WithdrawalScope
}) {
	const { t, i18n } = useTranslation()
	const text = (key: string, values?: Record<string, unknown>) =>
		t(`cinatoken.account.withdraw.${key}`, values)
	const manager = useWithdrawManager(props.api, props.scope)
	const form = useForm<WithdrawalForm>({
		resolver: zodResolver(withdrawalFormSchema),
		defaultValues: { amount: '' },
	})
	const money = (value: number) =>
		new Intl.NumberFormat(i18n.resolvedLanguage, {
			style: 'currency',
			currency: 'USD',
			minimumFractionDigits: 2,
			maximumFractionDigits: 6,
		}).format(value)
	const quantity = (value: number) =>
		new Intl.NumberFormat(i18n.resolvedLanguage, {
			maximumFractionDigits: 6,
		}).format(value)
	const history =
		!manager.blocked && !manager.history.isError
			? manager.history.data
			: undefined
	const wallet =
		!manager.blocked && !manager.wallet.isError
			? manager.wallet.data
			: undefined
	const pending =
		manager.connect.isPending ||
		manager.review.isPending ||
		manager.create.isPending
	const canReview = Boolean(
		history &&
		history.availability === 'available' &&
		history.walletAddress &&
		history.balance !== null &&
		history.dailyRemaining > 0 &&
		!hasActiveWithdrawal(history.activeWithdrawal) &&
		!pending &&
		!manager.blocked
	)
	const error =
		manager.create.error ?? manager.review.error ?? manager.connect.error
	return (
		<div className='space-y-5'>
			<div className='flex justify-end'>
				<Button
					variant='outline'
					disabled={
						pending || manager.wallet.isFetching || manager.history.isFetching
					}
					onClick={() => void manager.refresh()}
				>
					{text('refresh')}
				</Button>
			</div>
			{manager.blocked ? (
				<Alert variant='destructive'>
					<AlertDescription>
						{text(manager.blocked)}{' '}
						<Button variant='link' onClick={() => void manager.refresh()}>
							{text('verifySession')}
						</Button>
					</AlertDescription>
				</Alert>
			) : null}
			{manager.notice ? (
				<p role='status' className='bg-muted rounded-lg border p-3 text-sm'>
					{text(manager.notice)}
				</p>
			) : null}
			{manager.create.isPending ? (
				<p role='status' className='text-muted-foreground text-sm'>
					{text('submitting')}
				</p>
			) : null}
			{error ? (
				<Alert variant='destructive'>
					<AlertDescription>{text(withdrawalErrorKey(error))}</AlertDescription>
				</Alert>
			) : null}
			<Card>
				<CardHeader>
					<CardTitle>{text('wallet')}</CardTitle>
					<p className='text-muted-foreground text-sm'>{text('walletHint')}</p>
				</CardHeader>
				<CardContent className='space-y-4'>
					{!props.scope.walletAccess ? (
						<p className='text-muted-foreground text-sm'>
							{text('walletNoAccess')}
						</p>
					) : null}
					{props.scope.walletAccess && manager.wallet.isPending ? (
						<p role='status'>{text('loading')}</p>
					) : null}
					{manager.wallet.isError && !manager.blocked ? (
						<Alert variant='destructive'>
							<AlertDescription>
								{text('loadFailed')}{' '}
								<Button variant='link' onClick={() => void manager.refresh()}>
									{text('retry')}
								</Button>
							</AlertDescription>
						</Alert>
					) : null}
					{wallet ? (
						<>
							<p className='font-mono text-sm break-all'>
								{wallet.data.walletAddress ?? text('noWallet')}
							</p>
							<p className='text-muted-foreground text-sm'>
								{wallet.data.verifiedAt
									? text('verifiedAt', {
											time: new Intl.DateTimeFormat(i18n.resolvedLanguage, {
												dateStyle: 'medium',
												timeStyle: 'short',
											}).format(new Date(wallet.data.verifiedAt)),
										})
									: text('unverified')}
							</p>
							<p className='text-muted-foreground text-sm'>
								{text('chain', { id: wallet.chainId ?? text('unknown') })}
							</p>
							{wallet.availability === 'unavailable' ? (
								<Alert>
									<AlertDescription>
										{text('walletUnavailable')}
									</AlertDescription>
								</Alert>
							) : (
								<div className='flex flex-wrap gap-2'>
									<Button
										disabled={pending || Boolean(manager.blocked)}
										onClick={() => manager.connect.mutate()}
									>
										{text(
											wallet.data.walletAddress
												? 'replaceWallet'
												: 'connectWallet'
										)}
									</Button>
									{manager.connect.isPending ? (
										<Button variant='outline' onClick={manager.cancelWallet}>
											{text('cancel')}
										</Button>
									) : null}
								</div>
							)}
						</>
					) : null}
					{manager.phase ? (
						<p role='status' className='text-muted-foreground text-sm'>
							{text(`phase_${manager.phase}`)}
						</p>
					) : null}
				</CardContent>
			</Card>
			{!props.scope.withdrawalAccess ? (
				<Alert>
					<AlertDescription>{text('withdrawNoAccess')}</AlertDescription>
				</Alert>
			) : null}
			{props.scope.withdrawalAccess && manager.history.isPending ? (
				<p role='status'>{text('loading')}</p>
			) : null}
			{manager.history.isError && !manager.blocked ? (
				<Alert variant='destructive'>
					<AlertDescription>
						{text('loadFailed')}{' '}
						<Button variant='link' onClick={() => void manager.refresh()}>
							{text('retry')}
						</Button>
					</AlertDescription>
				</Alert>
			) : null}
			{history ? (
				<>
					<Card>
						<CardHeader>
							<CardTitle>{text('withdrawal')}</CardTitle>
							<p className='text-muted-foreground text-sm'>{text('units')}</p>
						</CardHeader>
						<CardContent className='space-y-5'>
							<dl className='grid grid-cols-2 gap-4 text-sm'>
								<div>
									<dt className='text-muted-foreground'>{text('balance')}</dt>
									<dd className='mt-1 font-semibold'>
										{history.balance === null
											? text('unknown')
											: money(history.balance)}
									</dd>
								</div>
								<div>
									<dt className='text-muted-foreground'>{text('locked')}</dt>
									<dd className='mt-1 font-semibold'>
										{history.lockedAmount === null
											? text('unknown')
											: money(history.lockedAmount)}
									</dd>
								</div>
								<div>
									<dt className='text-muted-foreground'>{text('minimum')}</dt>
									<dd>{money(history.policy.minAmount)}</dd>
								</div>
								<div>
									<dt className='text-muted-foreground'>{text('fee')}</dt>
									<dd>{money(history.policy.fee)}</dd>
								</div>
								<div>
									<dt className='text-muted-foreground'>{text('rate')}</dt>
									<dd>
										{text('rateValue', {
											rate: quantity(history.policy.tokenRate),
										})}
									</dd>
								</div>
								<div>
									<dt className='text-muted-foreground'>{text('daily')}</dt>
									<dd>
										{text('dailyValue', {
											remaining: history.dailyRemaining,
											limit: history.policy.dailyLimit,
										})}
									</dd>
								</div>
							</dl>
							{history.availability === 'unavailable' ? (
								<Alert>
									<AlertDescription>{text('unavailable')}</AlertDescription>
								</Alert>
							) : null}
							{history.balance === null ? (
								<Alert>
									<AlertDescription>
										{text('ledgerUnavailable')}
									</AlertDescription>
								</Alert>
							) : null}
							{!history.walletAddress ? (
								<Alert>
									<AlertDescription>{text('bindFirst')}</AlertDescription>
								</Alert>
							) : null}
							{hasActiveWithdrawal(history.activeWithdrawal) ? (
								<Alert>
									<AlertDescription>
										{text('activeOrder')}
										<p className='mt-1 font-mono text-xs break-all'>
											{history.activeWithdrawal?.id}
										</p>
									</AlertDescription>
								</Alert>
							) : null}
							<form
								className='space-y-3'
								onSubmit={form.handleSubmit((values) =>
									manager.requestReview(Number(values.amount))
								)}
								noValidate
							>
								<Label htmlFor='withdraw-amount'>{text('amount')}</Label>
								<Input
									id='withdraw-amount'
									inputMode='decimal'
									autoComplete='off'
									placeholder='10.000000'
									aria-invalid={Boolean(form.formState.errors.amount)}
									disabled={!canReview}
									{...form.register('amount')}
								/>
								{form.formState.errors.amount ? (
									<p className='text-destructive text-sm' role='alert'>
										{text('invalidAmount')}
									</p>
								) : null}
								<p className='text-muted-foreground text-xs'>
									{text('precision')}
								</p>
								<Button type='submit' disabled={!canReview}>
									{text(manager.review.isPending ? 'reviewing' : 'review')}
								</Button>
							</form>
						</CardContent>
					</Card>
					<WithdrawalHistory
						context={history}
						page={manager.page}
						pending={pending || manager.history.isFetching}
						onPage={manager.setPage}
					/>
				</>
			) : null}
			<Dialog
				open={manager.quote !== null}
				onOpenChange={(open) => {
					if (!open) manager.cancelQuote()
				}}
			>
				<DialogContent className='max-h-[90dvh] overflow-y-auto'>
					<DialogHeader>
						<DialogTitle>{text('reviewTitle')}</DialogTitle>
						<DialogDescription>{text('reviewHint')}</DialogDescription>
					</DialogHeader>
					{manager.quote ? (
						<dl className='space-y-3 text-sm'>
							<div className='flex justify-between gap-3'>
								<dt>{text('amount')}</dt>
								<dd>{money(manager.quote.data.amount)}</dd>
							</div>
							<div className='flex justify-between gap-3'>
								<dt>{text('fee')}</dt>
								<dd>{money(manager.quote.data.fee)}</dd>
							</div>
							<div className='flex justify-between gap-3'>
								<dt>{text('net')}</dt>
								<dd>{money(manager.quote.data.netAmount)}</dd>
							</div>
							<div className='flex justify-between gap-3'>
								<dt>{text('tokens')}</dt>
								<dd>{quantity(manager.quote.data.tokenAmount)} CINA-C</dd>
							</div>
							<div>
								<dt>{text('receivingWallet')}</dt>
								<dd className='mt-1 font-mono text-xs break-all'>
									{manager.quote.walletAddress}
								</dd>
							</div>
							<div>
								<dt>{text('balance')}</dt>
								<dd>
									{manager.quote.balance === null
										? text('unknown')
										: money(manager.quote.balance)}
								</dd>
							</div>
							<div>
								<dt>
									{text('chain', {
										id: manager.quote.chainId ?? text('unknown'),
									})}
								</dt>
							</div>
						</dl>
					) : null}
					<p className='text-muted-foreground text-xs'>{text('finality')}</p>
					<DialogFooter>
						<Button variant='outline' onClick={manager.cancelQuote}>
							{text('cancel')}
						</Button>
						<Button
							disabled={!manager.quote || pending || Boolean(manager.blocked)}
							onClick={() => manager.create.mutate()}
						>
							{text('confirm')}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	)
}

export function AccountWithdraw(props: { api: WalletApi & WithdrawalsApi }) {
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
	const walletAccess = session.user.capabilities.includes('wallet.manage')
	const withdrawalAccess =
		session.user.capabilities.includes('withdrawals.manage')
	return (
		<section aria-labelledby='withdraw-title' className='space-y-6'>
			<header className='space-y-2'>
				<h1
					id='withdraw-title'
					className='text-2xl font-semibold tracking-tight'
				>
					{t('cinatoken.account.withdraw.title')}
				</h1>
				<p className='text-muted-foreground max-w-3xl text-sm leading-6'>
					{t('cinatoken.account.withdraw.subtitle')}
				</p>
			</header>
			{walletAccess || withdrawalAccess ? (
				<ScopedWithdraw
					key={`${session.user.userId}:${workspace.id}:${session.scopeVersion}`}
					api={props.api}
					scope={{
						userId: session.user.userId,
						workspaceId: workspace.id,
						scopeVersion: session.scopeVersion,
						walletAccess,
						withdrawalAccess,
					}}
				/>
			) : (
				<Alert>
					<AlertDescription>
						{t('cinatoken.account.withdraw.noAccess')}
					</AlertDescription>
				</Alert>
			)}
		</section>
	)
}
