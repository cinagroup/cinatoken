/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import {
	Field,
	FieldDescription,
	FieldGroup,
	FieldLabel,
} from '@/components/ui/field'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { McpField, McpNotice, mcpPrefix } from './McpFields'
import { McpPricingSummary } from './McpPricingSummary'
import type { McpPricingRule } from './mcp-contracts'
import type { McpPricingDraft } from './mcp-input'

export function McpPricingFields(props: {
	draft: McpPricingDraft
	onChange: (draft: McpPricingDraft) => void
	disabled?: boolean
	currency: 'USD' | 'CNY' | null
}) {
	const { t } = useTranslation()
	const id = useId()
	const fields =
		props.draft.mode === 'v1'
			? (['standard', 'charged', 'metered'] as const)
			: (['standard', 'chargedFactor', 'meteredFactor'] as const)
	return (
		<FieldGroup>
			{!props.currency && <McpNotice message='currencyUnknown' />}
			<Field data-disabled={props.disabled || !props.currency || undefined}>
				<FieldLabel htmlFor={id}>{t(mcpPrefix + 'pricingMode')}</FieldLabel>
				<NativeSelect
					id={id}
					value={props.draft.mode}
					disabled={props.disabled || !props.currency}
					onChange={(event) => {
						if (event.target.value === 'v1' || event.target.value === 'v2')
							props.onChange({ ...props.draft, mode: event.target.value })
					}}
					className='w-full'
				>
					<NativeSelectOption value='v2'>
						{t(mcpPrefix + 'v2')}
					</NativeSelectOption>
					<NativeSelectOption value='v1'>
						{t(mcpPrefix + 'v1')}
					</NativeSelectOption>
				</NativeSelect>
				<FieldDescription>{t(mcpPrefix + 'pricingHint')}</FieldDescription>
			</Field>
			<FieldGroup className='grid gap-4 sm:grid-cols-3'>
				{fields.map((field) => (
					<McpField
						key={field}
						label={field}
						value={props.draft[field]}
						onChange={(value) =>
							props.onChange({ ...props.draft, [field]: value })
						}
						disabled={props.disabled || !props.currency}
						maxLength={40}
					/>
				))}
			</FieldGroup>
		</FieldGroup>
	)
}
export function McpPricingDetails(props: {
	rule: McpPricingRule | null
	currency: 'USD' | 'CNY' | null
}) {
	useTranslation()
	return (
		<McpPricingSummary
			rule={props.rule}
			currency={props.currency}
			showFactors
		/>
	)
}
