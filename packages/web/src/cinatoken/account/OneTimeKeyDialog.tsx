import { useState } from 'react'
import { Check, Copy, KeyRound } from 'lucide-react'
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

type OneTimeKeyDialogProps = {
	secret: string
	kind?: 'gateway' | 'management'
	onClose: () => void
}

export function OneTimeKeyDialog(props: OneTimeKeyDialogProps) {
	const { t } = useTranslation()
	const [copied, setCopied] = useState(false)
	const [copyFailed, setCopyFailed] = useState(false)
	const copySecret = async () => {
		try {
			await navigator.clipboard.writeText(props.secret)
			setCopied(true)
			setCopyFailed(false)
		} catch {
			setCopyFailed(true)
		}
	}

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) props.onClose()
			}}
		>
			<DialogContent className='sm:max-w-lg' showCloseButton={false}>
				<DialogHeader>
					<div className='bg-primary/10 text-primary mb-1 flex size-11 items-center justify-center rounded-xl'>
						<KeyRound className='size-5' aria-hidden='true' />
					</div>
					<DialogTitle>
						{t(
							props.kind === 'management'
								? 'cinatoken.account.managementKeys.secretTitle'
								: 'cinatoken.account.keys.secretTitle'
						)}
					</DialogTitle>
					<DialogDescription>
						{t(
							props.kind === 'management'
								? 'cinatoken.account.managementKeys.secretNotice'
								: 'cinatoken.account.keys.secretNotice'
						)}
					</DialogDescription>
				</DialogHeader>
				<div className='space-y-3'>
					<code className='bg-muted/50 block rounded-lg border p-4 font-mono text-sm break-all select-all'>
						{props.secret}
					</code>
					<Button
						variant='outline'
						onClick={() => void copySecret()}
						className='w-full'
					>
						{copied ? (
							<Check className='size-4' aria-hidden='true' />
						) : (
							<Copy className='size-4' aria-hidden='true' />
						)}
						{t(
							copied
								? 'cinatoken.account.keys.copied'
								: 'cinatoken.account.keys.copy'
						)}
					</Button>
					<p role='status' className='sr-only'>
						{copied ? t('cinatoken.account.keys.copied') : ''}
					</p>
					{copyFailed && (
						<p role='alert' className='text-destructive text-xs'>
							{t('cinatoken.account.keys.copyFailed')}
						</p>
					)}
				</div>
				<DialogFooter>
					<Button onClick={props.onClose}>
						{t('cinatoken.account.keys.secretDone')}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
