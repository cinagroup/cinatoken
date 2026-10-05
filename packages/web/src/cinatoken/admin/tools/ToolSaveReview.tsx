/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogTitle,
	DialogDescription,
} from '../../../components/ui/dialog'
import type { ToolDetail } from './tools-contracts'
import { toolsPrefix, type ToolCredentialField } from './tools-domain'
import type { ToolEditorForm } from './tools-editor-form'

export type ToolReviewOperation = 'save' | 'save_activate' | ToolCredentialField
export function ToolSaveReview(props: {
	detail: ToolDetail
	values: ToolEditorForm
	operation: ToolReviewOperation
	ack: boolean
	lossAck: boolean
	busy: boolean
	onAck: (value: boolean) => void
	onLossAck: (value: boolean) => void
	onSubmit: () => void
	onBack: () => void
}) {
	const { t } = useTranslation(),
		id = useId(),
		reveal = !['save', 'save_activate'].includes(props.operation),
		loss = Number(props.values.charged) < Number(props.values.metered)
	let submitLabel = 'confirmActivate'
	if (props.operation === 'save') submitLabel = 'confirmSave'
	if (reveal) submitLabel = 'reveal'
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) props.onBack()
			}}
		>
			<DialogContent
				showCloseButton={false}
				className='max-h-[85dvh] overflow-y-auto sm:max-w-2xl'
			>
				<DialogTitle>{t(toolsPrefix + submitLabel)}</DialogTitle>
				<DialogDescription>
					{t(toolsPrefix + (reveal ? 'revealHelp' : 'pageHelp'))}
				</DialogDescription>
				<div className='space-y-4'>
					<p>{t(toolsPrefix + (reveal ? 'revealConfirm' : 'confirmReview'))}</p>
					{!reveal && (
						<>
							<dl className='grid gap-2 sm:grid-cols-3'>
								{(['metered', 'standard', 'charged'] as const).map((name) => (
									<div key={name}>
										<dt>{t(toolsPrefix + 'unitPrices.' + name)}</dt>
										<dd>
											{props.values[name]} {props.detail.billingCurrency.value}
										</dd>
									</div>
								))}
							</dl>
							<ul>
								{props.detail.configuration.credentials.map((row) => (
									<li key={row.field}>
										{t(toolsPrefix + row.field)}:{' '}
										{t(toolsPrefix + props.values[`${row.field}Op`])}
									</li>
								))}
							</ul>
							{props.detail.family === 'ai-detection' && (
								<p>
									{t(toolsPrefix + 'billingUnitChars')}:{' '}
									{props.values.billingUnitChars} · {t(toolsPrefix + 'region')}:{' '}
									{t(toolsPrefix + props.values.regionOp)} ·{' '}
									{t(toolsPrefix + 'bizType')}:{' '}
									{t(toolsPrefix + props.values.bizTypeOp)}
								</p>
							)}
						</>
					)}
					<p className='break-all'>
						{t(toolsPrefix + 'reason')}: {props.values.reason}
					</p>
					{!reveal && loss && (
						<div className='space-y-2 rounded-lg border border-amber-500/50 p-3'>
							<p>{t(toolsPrefix + 'lossHint')}</p>
							<div className='flex items-start gap-2'>
								<input
									id={id + '-loss'}
									type='checkbox'
									checked={props.lossAck}
									disabled={props.busy}
									onChange={(event) => props.onLossAck(event.target.checked)}
								/>
								<label htmlFor={id + '-loss'}>
									{t(toolsPrefix + 'lossAck')}
								</label>
							</div>
						</div>
					)}
					<div className='flex items-start gap-2'>
						<input
							id={id + '-ack'}
							type='checkbox'
							checked={props.ack}
							disabled={props.busy}
							onChange={(event) => props.onAck(event.target.checked)}
						/>
						<label htmlFor={id + '-ack'}>
							{t(toolsPrefix + 'confirmReview')}
						</label>
					</div>
					<div className='flex flex-wrap gap-2'>
						<Button
							type='button'
							focusableWhenDisabled
							className='aria-disabled:opacity-50'
							disabled={
								!props.ack || props.busy || (!reveal && loss && !props.lossAck)
							}
							onClick={props.onSubmit}
						>
							{t(toolsPrefix + submitLabel)}
						</Button>
						<Button type='button' variant='outline' onClick={props.onBack}>
							{t(toolsPrefix + 'cancel')}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	)
}
