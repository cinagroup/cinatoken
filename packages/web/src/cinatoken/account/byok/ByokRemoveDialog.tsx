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
import type { ByokKey } from '../../byok-contracts'
import { byokErrorKey } from './use-byok-manager'

export function ByokRemoveDialog(props: {
	row: ByokKey
	isPending: boolean
	error: unknown
	onClose: () => void
	onConfirm: () => void
}) {
	const { t } = useTranslation()
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !props.isPending) props.onClose()
			}}
		>
			<DialogContent showCloseButton={false}>
				<DialogHeader>
					<DialogTitle>{t('cinatoken.account.byok.removeTitle')}</DialogTitle>
					<DialogDescription>
						{t('cinatoken.account.byok.removeNotice', {
							name:
								props.row.name || props.row.provider + ' ' + props.row.label,
						})}
					</DialogDescription>
				</DialogHeader>
				{Boolean(props.error) && (
					<p role='alert' className='text-destructive text-sm'>
						{t(byokErrorKey(props.error))}
					</p>
				)}
				<DialogFooter>
					<Button
						variant='outline'
						disabled={props.isPending}
						onClick={props.onClose}
					>
						{t('cinatoken.account.cancel')}
					</Button>
					<Button
						variant='destructive'
						disabled={props.isPending}
						onClick={props.onConfirm}
					>
						{t(
							props.isPending
								? 'cinatoken.account.byok.removing'
								: 'cinatoken.account.byok.remove'
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
