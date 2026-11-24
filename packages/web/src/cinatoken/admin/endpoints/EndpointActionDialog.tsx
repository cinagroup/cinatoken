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
import type { AdminEndpoint } from '../endpoint-contracts'
import { EndpointWriteFeedback } from './EndpointWriteFeedback'

const prefix = 'cinatoken.adminEndpoints.'

export function EndpointActionDialog(props: {
	row: AdminEndpoint
	action: 'delete' | 'publish' | 'draft' | 'disable'
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
			<DialogContent showCloseButton={false}>
				<DialogHeader>
					<DialogTitle>
						{t(prefix + 'confirm.' + props.action, { tag: props.row.tag })}
					</DialogTitle>
					<DialogDescription>
						{t(prefix + 'confirmHint.' + props.action)}
					</DialogDescription>
				</DialogHeader>
				{props.action === 'publish' && (
					<p className='text-muted-foreground rounded-xl border p-3 text-sm'>
						{t(prefix + 'publishRequirements')}
					</p>
				)}
				<EndpointWriteFeedback error={props.error} />
				<DialogFooter>
					<Button
						type='button'
						variant='outline'
						disabled={props.pending}
						onClick={props.onClose}
					>
						{t(prefix + 'cancel')}
					</Button>
					<Button
						type='button'
						variant={props.action === 'delete' ? 'destructive' : 'default'}
						disabled={props.disabled || props.error != null}
						onClick={props.onConfirm}
					>
						{t(prefix + 'confirmAction')}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
