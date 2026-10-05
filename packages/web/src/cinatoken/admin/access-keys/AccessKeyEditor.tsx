/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import {
	ACCESS_KEY_PERMISSIONS,
	type AccessKey,
	type AccessKeyPermission,
} from './access-key-contracts'

const prefix = 'cinatoken.adminAccessKeys.'
export type AccessKeyEditorMode =
	{ kind: 'create' } | { kind: 'edit'; key: AccessKey }
type Props = {
	editor: AccessKeyEditorMode
	name: string
	description: string
	permissions: AccessKeyPermission[]
	draftSecret: string | null
	draftVisible: boolean
	draftExpired: boolean
	revealed: { id: string; key: string } | null
	copiedId: string | null
	readBusyId: string | null
	errorKey: string | null
	busy: boolean
	canWrite: boolean
	onClose: () => void
	onName: (value: string) => void
	onDescription: (value: string) => void
	onPermission: (permission: AccessKeyPermission) => void
	onReveal: () => void
	onCopy: () => void
	onToggleDraftVisible: () => void
	onCopyDraft: () => void
	onRegenerate: () => void
	onSave: () => void
}
export function AccessKeyEditor(props: Props) {
	const { t } = useTranslation()
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) props.onClose()
			}}
		>
			<DialogContent
				showCloseButton={false}
				className='max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl'
			>
				<form
					className='space-y-4'
					onSubmit={(event) => {
						event.preventDefault()
						props.onSave()
					}}
				>
					<div className='flex items-center justify-between gap-3'>
						<DialogTitle className='text-xl font-semibold'>
							{t(
								prefix +
									(props.editor.kind === 'create' ? 'createTitle' : 'editTitle')
							)}
						</DialogTitle>
						<Button
							type='button'
							variant='outline'
							disabled={props.busy}
							onClick={props.onClose}
						>
							{t(prefix + 'close')}
						</Button>
					</div>
					{props.errorKey && (
						<p role='alert' className='text-destructive text-sm'>
							{t(prefix + props.errorKey)}
						</p>
					)}
					<div className='grid gap-3 sm:grid-cols-2'>
						<label className='space-y-1 text-sm'>
							<span>{t(prefix + 'name')}</span>
							<input
								className='bg-background w-full rounded-md border px-3 py-2'
								value={props.name}
								maxLength={255}
								disabled={props.busy}
								onChange={(event) => props.onName(event.target.value)}
							/>
						</label>
						<label className='space-y-1 text-sm'>
							<span>{t(prefix + 'description')}</span>
							<input
								className='bg-background w-full rounded-md border px-3 py-2'
								value={props.description}
								maxLength={10_000}
								disabled={props.busy}
								onChange={(event) => props.onDescription(event.target.value)}
							/>
						</label>
					</div>
					{props.editor.kind === 'edit' && (
						<div className='space-y-2'>
							<p className='text-sm font-medium'>
								{t(prefix + 'currentSecret')}
							</p>
							<code className='bg-muted block rounded p-2 text-xs break-all'>
								{props.revealed?.id === props.editor.key.id
									? props.revealed.key
									: props.editor.key.key}
							</code>
							<div className='flex flex-wrap gap-2'>
								<Button
									type='button'
									variant='outline'
									disabled={
										props.busy || props.readBusyId === props.editor.key.id
									}
									onClick={() => props.onReveal()}
								>
									{t(
										prefix +
											(props.revealed?.id === props.editor.key.id
												? 'hide'
												: 'reveal')
									)}
								</Button>
								<Button
									type='button'
									variant='outline'
									disabled={
										props.busy || props.readBusyId === props.editor.key.id
									}
									onClick={() => props.onCopy()}
								>
									{t(prefix + 'copy')}
								</Button>
							</div>
						</div>
					)}
					<div className='space-y-2'>
						<p className='text-sm font-medium'>{t(prefix + 'draftSecret')}</p>
						<p className='text-muted-foreground text-xs'>
							{t(prefix + 'draftHint')}
						</p>
						{props.draftExpired && (
							<p
								role='alert'
								className='text-sm text-amber-700 dark:text-amber-300'
							>
								{t(prefix + 'draftExpired')}
							</p>
						)}
						{props.draftSecret && (
							<code className='bg-muted block rounded p-2 text-xs break-all'>
								{props.draftVisible
									? props.draftSecret
									: props.draftSecret.slice(0, 12) + '••••••••'}
							</code>
						)}
						<div className='flex flex-wrap gap-2'>
							{props.draftSecret && (
								<>
									<Button
										type='button'
										variant='outline'
										disabled={props.busy}
										onClick={props.onToggleDraftVisible}
									>
										{t(prefix + (props.draftVisible ? 'hide' : 'reveal'))}
									</Button>
									<Button
										type='button'
										variant='outline'
										onClick={props.onCopyDraft}
									>
										{props.copiedId === 'draft'
											? t(prefix + 'copied')
											: t(prefix + 'copy')}
									</Button>
								</>
							)}
							<Button
								type='button'
								variant='outline'
								disabled={props.busy}
								onClick={props.onRegenerate}
							>
								{t(prefix + 'regenerate')}
							</Button>
						</div>
						{props.editor.kind === 'edit' && props.draftSecret && (
							<p className='text-sm text-amber-700 dark:text-amber-300'>
								{t(prefix + 'pendingHint')}
							</p>
						)}
					</div>
					<fieldset className='space-y-2'>
						<legend className='text-sm font-medium'>
							{t(prefix + 'permissions')}
						</legend>
						<div className='grid gap-2 sm:grid-cols-2'>
							{ACCESS_KEY_PERMISSIONS.map((permission) => (
								<label
									key={permission}
									className='flex items-center gap-2 rounded-md border p-2 text-sm'
								>
									<input
										type='checkbox'
										disabled={props.busy}
										checked={props.permissions.includes(permission)}
										onChange={() => props.onPermission(permission)}
									/>
									<code>
										{permission === '*'
											? t(prefix + 'allPermissions')
											: permission}
									</code>
								</label>
							))}
						</div>
						<p className='text-muted-foreground text-xs'>
							{t(prefix + 'wildcardNote')}
						</p>
					</fieldset>
					<div className='flex justify-end gap-2 border-t pt-4'>
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
							disabled={
								!props.canWrite ||
								props.draftExpired ||
								!props.name.trim() ||
								props.permissions.length === 0 ||
								(props.editor.kind === 'create' && !props.draftSecret)
							}
						>
							{t(prefix + (props.busy ? 'saving' : 'save'))}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	)
}
