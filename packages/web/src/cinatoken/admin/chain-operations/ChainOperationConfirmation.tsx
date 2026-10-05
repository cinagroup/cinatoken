/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from '../../../components/ui/dialog'
import {
	chainRejectReasonSchema,
	type AdminWithdrawalRow,
} from './chain-operations-contracts'
import { chainWriteErrorKey } from './chain-operations-errors'
import { chainAmount } from './chain-operations-format'

const prefix = 'cinatoken.adminChainOperations.'
export function ChainOperationConfirmation(props: {
	row: AdminWithdrawalRow | null
	limit: number
	busy: boolean
	disabled: boolean
	error: unknown
	onSubmit: (reason: string) => Promise<boolean>
	onClose: () => void
}) {
	const { t, i18n } = useTranslation()
	const id = useId()
	const [reason, setReason] = useState('')
	const [confirmed, setConfirmed] = useState(false)
	const reject = props.row !== null
	const valid =
		confirmed && (!reject || chainRejectReasonSchema.safeParse(reason).success)
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !props.busy) props.onClose()
			}}
		>
			<DialogContent
				showCloseButton={false}
				className='max-h-[85vh] overflow-y-auto sm:max-w-xl'
			>
				<DialogTitle>
					{t(prefix + (reject ? 'rejectTitle' : 'queueConfirmTitle'))}
				</DialogTitle>
				<DialogDescription>
					{t(prefix + (reject ? 'rejectHelp' : 'queueConfirmHelp'), {
						limit: props.limit,
					})}
				</DialogDescription>
				{props.row && (
					<dl className='bg-muted/40 space-y-2 rounded-lg p-3 text-sm'>
						<div>
							<dt className='text-muted-foreground'>{t(prefix + 'id')}</dt>
							<dd className='break-all'>{props.row.id}</dd>
						</div>
						<div>
							<dt className='text-muted-foreground'>{t(prefix + 'user')}</dt>
							<dd className='break-all'>{props.row.userId}</dd>
						</div>
						<div>
							<dt className='text-muted-foreground'>{t(prefix + 'amount')}</dt>
							<dd>
								{chainAmount(
									props.row.amount,
									i18n.resolvedLanguage ?? 'en',
									props.row.currency
								)}
							</dd>
						</div>
						<div>
							<dt className='text-muted-foreground'>{t(prefix + 'wallet')}</dt>
							<dd className='break-all'>{props.row.walletAddress}</dd>
						</div>
					</dl>
				)}
				<form
					className='space-y-4'
					onSubmit={(event) => {
						event.preventDefault()
						if (valid && !props.disabled && !props.busy)
							void props.onSubmit(reason).then((saved) => {
								if (saved) props.onClose()
							})
					}}
				>
					{reject && (
						<div className='space-y-2'>
							<label
								className='block text-sm font-medium'
								htmlFor={id + '-reason'}
							>
								{t(prefix + 'reason')}
							</label>
							<textarea
								id={id + '-reason'}
								value={reason}
								onChange={(event) => setReason(event.target.value)}
								maxLength={1000}
								required
								rows={3}
								disabled={props.busy || props.disabled}
								aria-describedby={id + '-hint'}
								className='bg-background w-full rounded-lg border p-3 text-sm'
							/>
							<p id={id + '-hint'} className='text-muted-foreground text-xs'>
								{t(prefix + 'reasonHint')}
							</p>
						</div>
					)}
					<label className='flex items-start gap-3 text-sm'>
						<input
							type='checkbox'
							checked={confirmed}
							onChange={(event) => setConfirmed(event.target.checked)}
							disabled={props.busy || props.disabled}
							className='mt-0.5'
						/>
						<span>
							{t(prefix + (reject ? 'rejectConfirm' : 'queueConfirm'))}
						</span>
					</label>
					{Boolean(props.error) && (
						<p role='alert' className='text-destructive text-sm'>
							{t(prefix + chainWriteErrorKey(props.error))}
						</p>
					)}
					<div className='flex flex-wrap justify-end gap-2'>
						<Button
							type='button'
							variant='outline'
							disabled={props.busy}
							onClick={props.onClose}
						>
							{t(prefix + 'cancel')}
						</Button>
						<Button
							type='submit'
							disabled={!valid || props.disabled || props.busy}
						>
							{t(prefix + (props.busy ? 'working' : 'confirm'))}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	)
}
