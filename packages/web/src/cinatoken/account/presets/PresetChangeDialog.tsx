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
import { presetErrorKey } from './preset-errors'
import type { PresetChange } from './use-presets-manager'

const titles = {
	archive: 'confirmArchive',
	restore: 'confirmRestore',
	public: 'confirmPublic',
	private: 'confirmPrivate',
	designate: 'confirmDesignate',
}
const prefix = 'cinatoken.presets.'
export function PresetChangeDialog(props: {
	change: PresetChange
	pending: boolean
	disabled: boolean
	error: unknown
	onConfirm: () => void
	onClose: () => void
}) {
	const { t } = useTranslation()
	const kind = props.change.kind
	let hint = 'scopeHint'
	if (kind === 'archive' || kind === 'restore') hint = 'archiveHint'
	if (kind === 'public' || kind === 'private') hint = 'publicHint'
	if (kind === 'designate') hint = 'designateHint'
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !props.pending) props.onClose()
			}}
		>
			<DialogContent className='sm:max-w-lg' showCloseButton={false}>
				<DialogHeader>
					<DialogTitle>
						{t(prefix + titles[kind], {
							name: props.change.row.name,
							version: props.change.version,
						})}
					</DialogTitle>
					<DialogDescription>{t(prefix + hint)}</DialogDescription>
				</DialogHeader>
				{props.error != null && (
					<p role='alert' className='text-destructive text-sm'>
						{t(presetErrorKey(props.error))}
					</p>
				)}
				<DialogFooter>
					<Button
						variant='outline'
						disabled={props.pending}
						onClick={props.onClose}
					>
						{t(prefix + 'cancel')}
					</Button>
					<Button
						variant={kind === 'archive' ? 'destructive' : 'default'}
						disabled={props.disabled || props.error != null}
						onClick={props.onConfirm}
					>
						{t(prefix + (props.pending ? 'changing' : 'confirm'))}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
