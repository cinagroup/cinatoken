/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useRef, type ComponentProps } from 'react'
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
import { McpNotice, mcpPrefix } from './McpFields'

export function McpConfirmDialog(props: {
	title: string
	message: string
	busy?: boolean
	canConfirm?: boolean
	error?: string | null
	destructive?: boolean
	children?: ComponentProps<typeof DialogContent>['children']
	onClose: () => void
	onConfirm: () => void
}) {
	const { t } = useTranslation()
	const title = useRef<HTMLHeadingElement>(null)
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !props.busy) props.onClose()
			}}
		>
			<DialogContent
				initialFocus={title}
				showCloseButton={false}
				className={
					props.children
						? 'max-h-[90dvh] overflow-y-auto sm:max-w-4xl'
						: undefined
				}
			>
				<DialogHeader>
					<DialogTitle ref={title} tabIndex={-1}>
						{t(mcpPrefix + props.title)}
					</DialogTitle>
					<DialogDescription>{t(mcpPrefix + props.message)}</DialogDescription>
				</DialogHeader>
				{props.error && <McpNotice message={props.error} destructive />}
				{props.children}
				<DialogFooter>
					<Button
						variant='outline'
						disabled={props.busy}
						onClick={props.onClose}
					>
						{t(mcpPrefix + 'cancel')}
					</Button>
					<Button
						variant={props.destructive ? 'destructive' : 'default'}
						disabled={props.busy || props.canConfirm === false}
						onClick={props.onConfirm}
					>
						{t(mcpPrefix + 'confirm')}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
