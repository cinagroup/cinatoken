/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { ToolCredentialEditor } from './ToolCredentialEditor'
import { ToolFormField } from './ToolFormField'
import type { ToolDetail } from './tools-contracts'
import { toolsPrefix, type ToolCredentialField } from './tools-domain'
import type { ToolEditorForm } from './tools-editor-form'

export function ToolEditFields(props: {
	form: UseFormReturn<ToolEditorForm>
	detail: ToolDetail
	disabled: boolean
	canReveal: boolean
	onReveal: (field: ToolCredentialField) => void
	onSecretInput: () => void
}) {
	const { t } = useTranslation()
	return (
		<div className='space-y-4'>
			<div>
				<p className='mb-2 text-sm'>
					{t(toolsPrefix + 'currency')}:{' '}
					{props.detail.billingCurrency.value ??
						t(toolsPrefix + 'invalidCurrency')}{' '}
					·{' '}
					{t(
						toolsPrefix +
							(props.detail.configuration.unit === 'chars'
								? 'priceUnitChars'
								: 'priceUnitRequest')
					)}
				</p>
				<div className='grid gap-3 sm:grid-cols-3'>
					{(['metered', 'standard', 'charged'] as const).map((name) => (
						<ToolFormField
							key={name}
							form={props.form}
							name={name}
							label={toolsPrefix + 'unitPrices.' + name}
							disabled={props.disabled}
						/>
					))}
				</div>
			</div>
			{props.detail.configuration.credentials.map((row) => (
				<ToolCredentialEditor
					key={row.field}
					form={props.form}
					name={row.field}
					configured={row.configured}
					disabled={props.disabled}
					canReveal={props.canReveal}
					onReveal={() => props.onReveal(row.field)}
					onSecretInput={props.onSecretInput}
				/>
			))}
			{props.detail.family === 'ai-detection' && (
				<>
					<ToolFormField
						form={props.form}
						name='billingUnitChars'
						label={toolsPrefix + 'billingUnitChars'}
						disabled={props.disabled}
					/>
					<p className='text-muted-foreground text-xs'>
						{t(toolsPrefix + 'aiBillingHelp')}
					</p>
					{(['region', 'bizType'] as const).map((name) => (
						<ToolCredentialEditor
							key={name}
							form={props.form}
							name={name}
							configured={props.detail.settings?.[name].source === 'configured'}
							setting={props.detail.settings?.[name].value}
							disabled={props.disabled}
						/>
					))}
				</>
			)}
			<ToolFormField
				form={props.form}
				name='reason'
				label={toolsPrefix + 'reason'}
				disabled={props.disabled && !props.canReveal}
			/>
		</div>
	)
}
