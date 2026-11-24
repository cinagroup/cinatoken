/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useRef, useState } from 'react'
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
import { McpPricingFields } from './McpPricingFields'
import type { McpPricingRule } from './mcp-contracts'
import { mcpPricingDraftFrom, mcpPricingFromDraft } from './mcp-input'

export function McpPricingDialog(props: {
	rule: McpPricingRule | null
	currency: 'USD' | 'CNY' | null
	busy: boolean
	canSave: boolean
	failure?: string | null
	onClose: () => void
	onSave: (rule: McpPricingRule | null) => Promise<boolean>
}) {
	const { t } = useTranslation()
	const title = useRef<HTMLHeadingElement>(null)
	const [draft, setDraft] = useState(() => mcpPricingDraftFrom(props.rule))
	const [error, setError] = useState<string | null>(null)
	async function save(inherit: boolean): Promise<void> {
		setError(null)
		let rule: McpPricingRule | null = null
		if (!inherit) {
			try {
				rule = mcpPricingFromDraft(draft)
			} catch {
				setError('invalidInput')
				return
			}
		}
		if (!(await props.onSave(rule))) setError('writeFailed')
	}
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
				className='max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl'
			>
				<DialogHeader>
					<DialogTitle ref={title} tabIndex={-1}>
						{t(mcpPrefix + 'overridePricing')}
					</DialogTitle>
					<DialogDescription>{t(mcpPrefix + 'pricingHint')}</DialogDescription>
				</DialogHeader>
				{error && (
					<McpNotice
						message={
							error === 'writeFailed' &&
							props.failure &&
							props.failure !== 'saved'
								? props.failure
								: error
						}
						destructive
					/>
				)}
				<McpPricingFields
					draft={draft}
					onChange={setDraft}
					currency={props.currency}
					disabled={props.busy}
				/>
				<DialogFooter>
					<Button
						variant='outline'
						disabled={props.busy}
						onClick={props.onClose}
					>
						{t(mcpPrefix + 'cancel')}
					</Button>
					<Button
						variant='outline'
						disabled={props.busy || !props.canSave || !props.currency}
						onClick={() => void save(true)}
					>
						{t(mcpPrefix + 'inherit')}
					</Button>
					<Button
						disabled={props.busy || !props.canSave || !props.currency}
						onClick={() => void save(false)}
					>
						{t(mcpPrefix + 'save')}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
