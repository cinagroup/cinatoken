/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from '../../../components/ui/dialog'
import { chainWriteErrorKey } from './chain-operations-errors'

const prefix = 'cinatoken.adminChainOperations.'
export function ChainUnknownReview(props: {
	busy: boolean
	disabled: boolean
	error: unknown
	onSubmit: (checked: {
		reviewedExternal: boolean
		acceptsUnknown: boolean
	}) => Promise<boolean>
	onClose: () => void
}) {
	const { t } = useTranslation()
	const [reviewedExternal, setReviewedExternal] = useState(false)
	const [acceptsUnknown, setAcceptsUnknown] = useState(false)
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
				<DialogTitle>{t(prefix + 'manualReviewTitle')}</DialogTitle>
				<DialogDescription>{t(prefix + 'manualReviewHelp')}</DialogDescription>
				<label className='flex items-start gap-3 text-sm'>
					<input
						type='checkbox'
						checked={reviewedExternal}
						disabled={props.busy || props.disabled}
						onChange={(event) => setReviewedExternal(event.target.checked)}
						className='mt-0.5'
					/>
					<span>{t(prefix + 'reviewedExternal')}</span>
				</label>
				<label className='flex items-start gap-3 text-sm'>
					<input
						type='checkbox'
						checked={acceptsUnknown}
						disabled={props.busy || props.disabled}
						onChange={(event) => setAcceptsUnknown(event.target.checked)}
						className='mt-0.5'
					/>
					<span>{t(prefix + 'acceptsUnknown')}</span>
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
						type='button'
						disabled={
							!reviewedExternal ||
							!acceptsUnknown ||
							props.busy ||
							props.disabled
						}
						onClick={() => {
							void props
								.onSubmit({ reviewedExternal, acceptsUnknown })
								.then((released) => {
									if (released) props.onClose()
								})
						}}
					>
						{t(prefix + (props.busy ? 'working' : 'manualReview'))}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	)
}
