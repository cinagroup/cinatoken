/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import type { ToolDetail, ToolFamilySummary } from './tools-contracts'
import {
	toolsPrefix,
	familyMessageKeys,
	toolProviderLabelKey,
} from './tools-domain'

export function ToolsProfile(props: {
	state: ToolFamilySummary | ToolDetail['familyState']
	currency: ToolDetail['billingCurrency']
}) {
	const { t } = useTranslation(),
		state = props.state
	const provider = (value: typeof state.savedActive) =>
		value === null
			? t(toolsPrefix + 'none')
			: t(toolProviderLabelKey(state.family, value))
	return (
		<dl className='grid min-w-0 gap-2 text-sm sm:grid-cols-2'>
			<div>
				<dt className='text-muted-foreground'>
					{t(toolsPrefix + 'catalog.' + familyMessageKeys[state.family])}
				</dt>
				<dd>{t(toolsPrefix + 'source_' + state.source)}</dd>
				<dd className='text-muted-foreground text-xs'>
					{t(toolsPrefix + 'catalogState')}:{' '}
					{t(toolsPrefix + 'catalogState_' + state.catalogState)}
				</dd>
			</div>
			<div>
				<dt className='text-muted-foreground'>{t(toolsPrefix + 'currency')}</dt>
				<dd>
					{props.currency.value ?? t(toolsPrefix + 'invalidCurrency')} ·{' '}
					{t(toolsPrefix + 'currency_' + props.currency.source)}
				</dd>
			</div>
			<div>
				<dt className='text-muted-foreground'>
					{t(toolsPrefix + 'savedActive')}
				</dt>
				<dd>{provider(state.savedActive)}</dd>
				<dd className='text-muted-foreground text-xs'>
					{t(toolsPrefix + 'activeState_' + state.activeState)}
				</dd>
			</div>
			<div>
				<dt className='text-muted-foreground'>
					{t(toolsPrefix + 'effectiveProvider')}
				</dt>
				<dd>{provider(state.effectiveProvider)}</dd>
			</div>
			<div className='sm:col-span-2'>
				<dt className='text-muted-foreground'>
					{t(toolsPrefix + 'configurationReady')}
				</dt>
				<dd>
					{t(
						toolsPrefix + (state.configurationReady ? 'configured' : 'notReady')
					)}{' '}
					· {t(toolsPrefix + 'issue_' + state.configurationIssue)}
				</dd>
				<p className='text-muted-foreground text-xs'>
					{t(toolsPrefix + 'readyHint')}
				</p>
			</div>
			<div className='sm:col-span-2'>
				<dt className='text-muted-foreground'>
					{t(toolsPrefix + 'currentVersion')}
				</dt>
				<dd>
					<code className='block text-xs break-all'>{state.version}</code>
				</dd>
			</div>
		</dl>
	)
}
