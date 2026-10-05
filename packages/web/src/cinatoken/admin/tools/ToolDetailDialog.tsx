/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogTitle,
	DialogDescription,
} from '../../../components/ui/dialog'
import { ToolEditor } from './ToolEditor'
import { ToolsProfile } from './ToolsProfile'
import type { ToolDetail } from './tools-contracts'
import {
	toolsPrefix,
	toolProviderLabelKey,
	type ToolFamily,
	type ToolProvider,
} from './tools-domain'
import { toolErrorKey } from './tools-errors'
import type { AdminToolsProps, ToolsManager } from './use-admin-tools'

export function ToolDetailDialog(props: {
	context: AdminToolsProps
	manager: ToolsManager
	family: ToolFamily
	provider: ToolProvider
	onClose: () => void
}) {
	const { t } = useTranslation(),
		[detail, setDetail] = useState<ToolDetail | null>(null),
		[error, setError] = useState<string | null>(null),
		active = useRef(true)
	const accessLost = props.manager.accessLost
	useEffect(() => {
		active.current = true
		const abort = new AbortController()
		void props.context.api
			.adminToolDetail(props.family, props.provider, { signal: abort.signal })
			.then((value) => {
				if (active.current && !abort.signal.aborted) setDetail(value)
			})
			.catch((failure) => {
				if (active.current && !abort.signal.aborted) {
					setDetail(null)
					setError(toolErrorKey(failure))
					accessLost('read', failure)
				}
			})
		return () => {
			active.current = false
			abort.abort()
		}
	}, [props.context.api, props.family, props.provider, accessLost])
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
				<DialogTitle>
					{t(toolsPrefix + 'edit')} ·{' '}
					{t(toolProviderLabelKey(props.family, props.provider))}
				</DialogTitle>
				<DialogDescription>{t(toolsPrefix + 'pageHelp')}</DialogDescription>
				{error && (
					<p role='alert' className='text-destructive'>
						{t(toolsPrefix + error)}
					</p>
				)}
				{!detail && !error && <p role='status'>{t(toolsPrefix + 'loading')}</p>}
				{detail && (
					<>
						<ToolsProfile
							state={detail.familyState}
							currency={detail.billingCurrency}
						/>
						<ToolEditor
							detail={detail}
							context={props.context}
							manager={props.manager}
							onClose={props.onClose}
						/>
					</>
				)}
				{!detail && (
					<Button type='button' variant='outline' onClick={props.onClose}>
						{t(toolsPrefix + 'cancel')}
					</Button>
				)}
			</DialogContent>
		</Dialog>
	)
}
