/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import type { ToolDetail } from './tools-contracts'
import { toolsPrefix, toolProviderLabelKey } from './tools-domain'

export function ToolsCurrentConfiguration(props: { detail: ToolDetail }) {
	const { t } = useTranslation(),
		detail = props.detail
	return (
		<div className='min-w-0 space-y-2 rounded-lg border p-3 text-sm'>
			<h3 className='font-medium'>
				{t(toolProviderLabelKey(detail.family, detail.provider))}
			</h3>
			<ul>
				{detail.configuration.credentials.map((row) => (
					<li key={row.field}>
						{t(toolsPrefix + row.field)}:{' '}
						{t(toolsPrefix + (row.configured ? 'configured' : 'missing'))}
					</li>
				))}
			</ul>
			<dl className='grid grid-cols-3 gap-2'>
				{(['metered', 'standard', 'charged'] as const).map((name) => (
					<div key={name}>
						<dt>{t(toolsPrefix + 'unitPrices.' + name)}</dt>
						<dd className='break-all'>
							{detail.billingCurrency.value === null
								? t(toolsPrefix + 'source_unavailable')
								: (detail.configuration.prices?.[name] ??
									t(toolsPrefix + 'none'))}{' '}
							{detail.billingCurrency.value ?? ''}
						</dd>
					</div>
				))}
			</dl>
			<p>
				{t(
					toolsPrefix +
						(detail.configuration.unit === 'chars'
							? 'priceUnitChars'
							: 'priceUnitRequest')
				)}
				{detail.configuration.billingUnitChars !== null &&
					` · ${detail.configuration.billingUnitChars}`}
			</p>
			{detail.settings && (
				<dl>
					{(['region', 'bizType'] as const).map((name) => (
						<div key={name}>
							<dt>{t(toolsPrefix + name)}</dt>
							<dd className='break-all'>
								{detail.settings?.[name].value ??
									t(toolsPrefix + 'unavailableSetting')}
							</dd>
						</div>
					))}
				</dl>
			)}
		</div>
	)
}
