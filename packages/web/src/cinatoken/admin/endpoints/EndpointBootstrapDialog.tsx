/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '../../../components/ui/dialog'
import type { EndpointBootstrapResult } from '../endpoint-contracts'
import { endpointErrorKey } from './endpoint-errors'

const prefix = 'cinatoken.adminEndpoints.'

export function EndpointBootstrapDialog(props: {
	result: EndpointBootstrapResult | null
	pending: boolean
	disabled: boolean
	error: unknown
	onConfirm: () => void
	onClose: () => void
}) {
	const { t } = useTranslation()
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !props.pending) props.onClose()
			}}
		>
			<DialogContent
				className='max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl'
				showCloseButton={false}
			>
				<DialogHeader>
					<DialogTitle>{t(prefix + 'bootstrapTitle')}</DialogTitle>
					<DialogDescription>{t(prefix + 'bootstrapHint')}</DialogDescription>
				</DialogHeader>
				{props.result && (
					<div className='space-y-3' role='status'>
						<p className='text-sm'>
							{t(prefix + 'bootstrapCounts', {
								published: props.result.published,
								linked: props.result.linked_routes,
								skipped: props.result.skipped,
								failed: props.result.failed,
							})}
						</p>
						<div className='max-h-64 space-y-2 overflow-y-auto rounded-xl border p-3'>
							{props.result.models.map((item) => (
								<div
									key={item.model_id}
									className='flex flex-wrap justify-between gap-2 border-b py-1 text-sm'
								>
									<span className='font-mono break-all'>{item.model_id}</span>
									<span>
										{t(prefix + 'bootstrapOutcome.' + item.status)} ·{' '}
										{item.linked_routes}
									</span>
								</div>
							))}
						</div>
						<p className='text-muted-foreground text-xs'>
							{t(prefix + 'bootstrapResultHint')}
						</p>
					</div>
				)}
				{props.error != null && (
					<div role='alert' className='text-destructive space-y-2 text-sm'>
						<p>{t(endpointErrorKey(props.error))}</p>
						<p>{t(prefix + 'writeUnknown')}</p>
					</div>
				)}
				<DialogFooter>
					<Button
						type='button'
						variant='outline'
						disabled={props.pending}
						onClick={props.onClose}
					>
						{t(prefix + 'close')}
					</Button>
					{!props.result && (
						<Button
							type='button'
							disabled={props.disabled || props.error != null}
							onClick={props.onConfirm}
						>
							{t(prefix + (props.pending ? 'saving' : 'bootstrapConfirm'))}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
