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
import type { AdminProvider } from '../provider-contracts'
import { providerErrorKey } from './provider-errors'

const prefix = 'cinatoken.adminProviders.'
export function ProviderChangeDialog(props: {
	row: AdminProvider
	action: 'delete' | 'status'
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
						{t(
							prefix +
								(props.action === 'delete' ? 'confirmDelete' : 'confirmStatus'),
							{ name: props.row.name }
						)}
					</DialogTitle>
					<DialogDescription>
						{t(
							prefix + (props.action === 'delete' ? 'deleteHint' : 'statusHint')
						)}
					</DialogDescription>
				</DialogHeader>
				{props.error != null && (
					<div role='alert' className='text-destructive space-y-2 text-sm'>
						<p>{t(providerErrorKey(props.error))}</p>
						<p>{t(prefix + 'writeUnknown')}</p>
					</div>
				)}
				<DialogFooter>
					<Button
						variant='outline'
						onClick={props.onClose}
						disabled={props.pending}
					>
						{t(prefix + 'cancel')}
					</Button>
					<Button
						variant={props.action === 'delete' ? 'destructive' : 'default'}
						onClick={props.onConfirm}
						disabled={props.disabled || props.error != null}
					>
						{t(prefix + 'confirm')}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
