import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { SharedKeyHistoryConflict } from '../../shared-key-api'
import type { SharedKey } from '../../shared-key-contracts'
import { sharedKeyErrorKey } from './use-shared-keys'

const prefix = 'cinatoken.account.sharedKeys.'
export function SharedKeyDeleteDialog(props: {
	row: SharedKey
	pending: boolean
	error: unknown
	onConfirm: () => void
	onPause: () => void
	onClose: () => void
}) {
	const { t } = useTranslation()
	const historyLocked = props.error instanceof SharedKeyHistoryConflict
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !props.pending) props.onClose()
			}}
		>
			<DialogContent
				className='max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg'
				showCloseButton={false}
			>
				<DialogHeader>
					<DialogTitle>{t(prefix + 'removeTitle')}</DialogTitle>
					<DialogDescription>
						{t(prefix + 'removeNotice', {
							name: props.row.label || props.row.keyFingerprint,
						})}
					</DialogDescription>
				</DialogHeader>
				<p className='text-muted-foreground text-sm'>
					{t(prefix + 'historyNotice')}
				</p>
				{props.error != null && (
					<p
						role='alert'
						className='text-destructive rounded-lg border p-3 text-sm'
					>
						{t(sharedKeyErrorKey(props.error, 'delete'))}
					</p>
				)}
				<DialogFooter className='flex-wrap'>
					<Button
						variant='outline'
						disabled={props.pending}
						onClick={props.onClose}
					>
						{t('cinatoken.account.cancel')}
					</Button>
					{historyLocked && props.row.status === 'active' && (
						<Button
							variant='outline'
							disabled={props.pending}
							onClick={props.onPause}
						>
							{t(prefix + 'pauseInstead')}
						</Button>
					)}
					<Button
						variant='destructive'
						disabled={props.pending || historyLocked}
						onClick={props.onConfirm}
					>
						{t(prefix + (props.pending ? 'removing' : 'remove'))}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
