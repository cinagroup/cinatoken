/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogTitle,
	DialogDescription,
} from '../../../components/ui/dialog'
import { ToolsAuditEntries } from './ToolsAuditEntries'
import { ToolsCurrentConfiguration } from './ToolsCurrentConfiguration'
import { ToolsProfile } from './ToolsProfile'
import {
	toolsPrefix,
	toolProviderLabelKey,
	type ToolProvider,
} from './tools-domain'
import type { ToolMarker } from './tools-marker'
import type { AdminToolsProps, ToolsManager } from './use-admin-tools'
import { useToolManualRecovery } from './use-tool-manual-recovery'

type Props = {
	context: AdminToolsProps
	manager: ToolsManager
	onRecovered: () => void
}
export function ToolsManualRecovery(props: Props) {
	const { t } = useTranslation(),
		[opened, setOpened] = useState<ToolMarker | null>(null)
	if (props.manager.writeStatus !== 'pending' && !opened) return null
	const marker = props.manager.stores.write.marker(props.manager.identity)
	if (!marker && !opened)
		return <p role='alert'>{t(toolsPrefix + 'recoveryUnavailable')}</p>
	return (
		<div>
			{marker && (
				<Button
					type='button'
					variant='outline'
					onClick={() => setOpened(marker)}
				>
					{t(toolsPrefix + 'recover')}
				</Button>
			)}
			{opened && (
				<RecoveryDialog
					key={opened.generation}
					{...props}
					marker={opened}
					onClose={() => setOpened(null)}
					onRecovered={() => {
						setOpened(null)
						props.onRecovered()
					}}
				/>
			)}
		</div>
	)
}
function RecoveryDialog(
	props: Props & { marker: ToolMarker; onClose: () => void }
) {
	const { t } = useTranslation(),
		id = useId()
	const { evidence, ack, setAck, busy, error, cursors, run } =
		useToolManualRecovery(props)
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) props.onClose()
			}}
		>
			<DialogContent
				showCloseButton={false}
				className='max-h-[85dvh] overflow-y-auto sm:max-w-3xl'
			>
				<DialogTitle>{t(toolsPrefix + 'recover')}</DialogTitle>
				<DialogDescription>{t(toolsPrefix + 'recoveryHelp')}</DialogDescription>
				<p>
					{t(
						toolProviderLabelKey(
							props.marker.family,
							props.marker.provider as ToolProvider
						)
					)}{' '}
					· {t(toolsPrefix + 'auditOperation_' + props.marker.operation)}
				</p>
				<Button
					type='button'
					variant='outline'
					className='aria-disabled:opacity-50'
					focusableWhenDisabled
					disabled={busy}
					onClick={() => void run('inspect')}
				>
					{t(toolsPrefix + 'inspect')}
				</Button>
				{busy && <p role='status'>{t(toolsPrefix + 'loading')}</p>}
				{error && (
					<p role='alert' className='text-destructive'>
						{t(toolsPrefix + error)}
					</p>
				)}
				{evidence && (
					<>
						<ToolsProfile
							state={evidence.detail.familyState}
							currency={evidence.detail.billingCurrency}
						/>
						<ToolsCurrentConfiguration detail={evidence.detail} />
						<p>{t(toolsPrefix + 'auditScope')}</p>
						<ToolsAuditEntries
							page={evidence.audit}
							family={props.marker.family}
						/>
						<div className='flex flex-wrap gap-2'>
							<Button
								type='button'
								variant='outline'
								focusableWhenDisabled
								className='aria-disabled:opacity-50'
								disabled={busy || cursors.length < 2}
								onClick={() =>
									void run('page', cursors[cursors.length - 2], true)
								}
							>
								{t(toolsPrefix + 'previous')}
							</Button>
							<Button
								type='button'
								variant='outline'
								focusableWhenDisabled
								className='aria-disabled:opacity-50'
								disabled={busy || !evidence.audit.next_cursor}
								onClick={() => void run('page', evidence.audit.next_cursor)}
							>
								{t(toolsPrefix + 'more')}
							</Button>
						</div>
					</>
				)}
				<div className='flex items-start gap-2'>
					<input
						id={id}
						type='checkbox'
						checked={ack}
						disabled={!evidence || busy}
						onChange={(event) => setAck(event.target.checked)}
					/>
					<label htmlFor={id}>{t(toolsPrefix + 'recoveryAck')}</label>
				</div>
				<div className='flex flex-wrap gap-2'>
					<Button
						type='button'
						focusableWhenDisabled
						className='aria-disabled:opacity-50'
						disabled={!evidence || !ack || busy}
						onClick={() => void run('ack')}
					>
						{t(toolsPrefix + 'recoveryConfirm')}
					</Button>
					<Button type='button' variant='outline' onClick={props.onClose}>
						{t(toolsPrefix + 'cancel')}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	)
}
