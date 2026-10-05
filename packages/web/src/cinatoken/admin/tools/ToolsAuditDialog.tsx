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
import { ToolsAuditEntries } from './ToolsAuditEntries'
import type { AdminToolsApi } from './tools-api'
import type { ToolAuditPage } from './tools-audit'
import { toolsPrefix, type ToolFamily } from './tools-domain'
import { toolErrorKey } from './tools-errors'

export function ToolsAuditDialog(props: {
	api: AdminToolsApi
	family: ToolFamily
	onClose: () => void
	onAccessLost: (error: unknown) => void
}) {
	const { t } = useTranslation(),
		[page, setPage] = useState<ToolAuditPage | null>(null),
		[error, setError] = useState<string | null>(null),
		[busy, setBusy] = useState(true),
		[cursors, setCursors] = useState<Array<string | null>>([null])
	const active = useRef(true),
		controller = useRef<AbortController | null>(null)
	const onAccessLost = props.onAccessLost
	async function load(cursor: string | null, back = false) {
		if (controller.current) return
		const abort = new AbortController()
		controller.current = abort
		setBusy(true)
		try {
			const value = await props.api.adminToolAudit(props.family, cursor, {
				signal: abort.signal,
			})
			if (!active.current || abort.signal.aborted) return
			setPage(value)
			setError(null)
			setCursors((current) => {
				if (!back) return [...current, cursor]
				const previous = current.slice(0, -1)
				return previous.length ? previous : [null]
			})
		} catch (failure) {
			if (active.current && !abort.signal.aborted) {
				setPage(null)
				setError(toolErrorKey(failure))
				props.onAccessLost(failure)
			}
		} finally {
			if (active.current) {
				controller.current = null
				setBusy(false)
			}
		}
	}
	useEffect(() => {
		active.current = true
		const abort = new AbortController()
		controller.current = abort
		void props.api
			.adminToolAudit(props.family, null, { signal: abort.signal })
			.then((value) => {
				if (active.current && !abort.signal.aborted) setPage(value)
			})
			.catch((failure) => {
				if (active.current && !abort.signal.aborted) {
					setError(toolErrorKey(failure))
					onAccessLost(failure)
				}
			})
			.finally(() => {
				if (active.current && !abort.signal.aborted) {
					controller.current = null
					setBusy(false)
				}
			})
		return () => {
			active.current = false
			abort.abort()
			controller.current?.abort()
		}
	}, [props.api, props.family, onAccessLost])
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
				<DialogTitle>{t(toolsPrefix + 'audit')}</DialogTitle>
				<DialogDescription>{t(toolsPrefix + 'auditScope')}</DialogDescription>
				{busy && <p role='status'>{t(toolsPrefix + 'loading')}</p>}
				{error && (
					<p role='alert' className='text-destructive'>
						{t(toolsPrefix + error)}
					</p>
				)}
				{page && <ToolsAuditEntries page={page} family={props.family} />}
				<div className='flex flex-wrap gap-2'>
					<Button
						type='button'
						variant='outline'
						focusableWhenDisabled
						className='aria-disabled:opacity-50'
						disabled={busy || cursors.length < 2}
						onClick={() => void load(cursors[cursors.length - 2], true)}
					>
						{t(toolsPrefix + 'previous')}
					</Button>
					<Button
						type='button'
						variant='outline'
						focusableWhenDisabled
						className='aria-disabled:opacity-50'
						disabled={busy || !page?.next_cursor}
						onClick={() => {
							if (page?.next_cursor) void load(page.next_cursor)
						}}
					>
						{t(toolsPrefix + 'more')}
					</Button>
					<Button type='button' variant='outline' onClick={props.onClose}>
						{t(toolsPrefix + 'close')}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	)
}
