import { useTranslation } from 'react-i18next'
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import type { GatewayKey } from '../contracts'

type RevokeKeyDialogProps = {
	gatewayKey: GatewayKey
	isPending: boolean
	error: boolean
	onClose: () => void
	onConfirm: () => void
}

export function RevokeKeyDialog(props: RevokeKeyDialogProps) {
	const { t } = useTranslation()
	return (
		<AlertDialog
			open
			onOpenChange={(open) => {
				if (!open && !props.isPending) props.onClose()
			}}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>
						{t('cinatoken.account.keys.revokeTitle')}
					</AlertDialogTitle>
					<AlertDialogDescription>
						{t('cinatoken.account.keys.revokeNotice', {
							name: props.gatewayKey.name || props.gatewayKey.key,
						})}
					</AlertDialogDescription>
				</AlertDialogHeader>
				{props.error && (
					<p role='alert' className='text-destructive text-sm'>
						{t('cinatoken.account.keys.revokeFailed')}
					</p>
				)}
				<AlertDialogFooter>
					<AlertDialogCancel disabled={props.isPending}>
						{t('cinatoken.account.cancel')}
					</AlertDialogCancel>
					<AlertDialogAction
						variant='destructive'
						disabled={props.isPending}
						onClick={props.onConfirm}
					>
						{t(
							props.isPending
								? 'cinatoken.account.keys.revoking'
								: 'cinatoken.account.keys.revoke'
						)}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}
