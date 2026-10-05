/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import { ToolsProfile } from './ToolsProfile'
import type { ToolFamilySummary, ToolOverview } from './tools-contracts'
import {
	toolsPrefix,
	familyMessageKeys,
	toolProviderLabelKey,
	toolDocsHref,
	toolPlaygroundHref,
	toolInvocationsHref,
	type ToolProvider,
} from './tools-domain'

export function ToolsFamilySection(props: {
	state: ToolFamilySummary
	currency: ToolOverview['billingCurrency']
	capabilities: ToolOverview['capabilities']
	canEdit: boolean
	canAudit: boolean
	busy: boolean
	onEdit: (provider: ToolProvider) => void
	onAudit: () => void
}) {
	const { t } = useTranslation(),
		family = props.state.family,
		key = familyMessageKeys[family]
	return (
		<section className='min-w-0 space-y-4 rounded-xl border p-4'>
			<header className='flex flex-wrap items-center justify-between gap-3'>
				<h2 className='text-xl font-semibold'>
					{t(toolsPrefix + 'catalog.' + key)}
				</h2>
				<div className='flex flex-wrap gap-3'>
					{props.capabilities.can_invocations && (
						<a
							href={toolInvocationsHref(family)}
							className='text-primary text-sm underline'
						>
							{t(toolsPrefix + 'invocations')}
						</a>
					)}
					<Button
						type='button'
						size='sm'
						variant='outline'
						disabled={!props.canAudit || props.busy}
						onClick={props.onAudit}
					>
						{t(toolsPrefix + 'audit')}
					</Button>
				</div>
			</header>
			<p className='text-muted-foreground text-sm'>
				{t(toolsPrefix + key + '.descriptionCatalog')}
			</p>
			<ToolsProfile state={props.state} currency={props.currency} />
			{!props.state.editable && (
				<p role='status' className='text-sm'>
					{t(
						toolsPrefix +
							(props.state.editBlockedCode === 'invalid_currency'
								? 'invalidCurrency'
								: 'blockedSource')
					)}
				</p>
			)}
			<div className='grid gap-3 md:grid-cols-2'>
				{props.state.providers.map((provider) => {
					const docs = toolDocsHref(family, provider.provider)
					return (
						<article
							key={provider.provider}
							className='min-w-0 space-y-3 rounded-lg border p-4'
						>
							<h3 className='font-medium'>
								{t(toolProviderLabelKey(family, provider.provider))}
							</h3>
							<p className='text-sm'>
								{t(
									toolsPrefix +
										(props.state.effectiveProvider === provider.provider
											? 'providerCards.active'
											: 'source_' + provider.entrySource)
								)}{' '}
								·{' '}
								{t(
									toolsPrefix + (provider.configured ? 'configured' : 'missing')
								)}
							</p>
							{!provider.implemented && (
								<p>{t(toolsPrefix + 'issue_not_implemented')}</p>
							)}
							<ul className='text-sm'>
								{provider.credentials.map((row) => (
									<li key={row.field}>
										{t(toolsPrefix + row.field)}:{' '}
										{t(
											toolsPrefix + (row.configured ? 'configured' : 'missing')
										)}
									</li>
								))}
							</ul>
							<dl className='grid grid-cols-3 gap-2 text-sm'>
								{(['metered', 'standard', 'charged'] as const).map((name) => (
									<div key={name}>
										<dt className='text-muted-foreground'>
											{t(toolsPrefix + 'unitPrices.' + name)}
										</dt>
										<dd className='break-all'>
											{props.currency.value === null
												? t(toolsPrefix + 'source_unavailable')
												: (provider.prices?.[name] ??
													t(toolsPrefix + 'none'))}{' '}
											{props.currency.value ?? ''}
										</dd>
									</div>
								))}
							</dl>
							<p className='text-muted-foreground text-xs'>
								{t(
									toolsPrefix +
										(provider.unit === 'chars'
											? 'priceUnitChars'
											: 'priceUnitRequest')
								)}
								{provider.billingUnitChars !== null &&
									` · ${provider.billingUnitChars}`}
							</p>
							{provider.isLossPricing && (
								<p className='text-sm text-amber-700 dark:text-amber-400'>
									{t(toolsPrefix + 'lossHint')}
								</p>
							)}
							<div className='flex flex-wrap items-center gap-3'>
								<Button
									type='button'
									size='sm'
									variant='outline'
									disabled={!props.canEdit || props.busy}
									onClick={() => props.onEdit(provider.provider)}
								>
									{t(toolsPrefix + 'edit')}
								</Button>
								{docs && (
									<a
										href={docs}
										target='_blank'
										rel='noreferrer'
										className='text-primary text-sm underline'
									>
										{t(toolsPrefix + 'toolDocs')}
									</a>
								)}
								{props.capabilities.can_playground && (
									<a
										href={toolPlaygroundHref(family, provider.provider)}
										className='text-primary text-sm underline'
									>
										{t(toolsPrefix + 'playground')}
									</a>
								)}
							</div>
						</article>
					)
				})}
			</div>
			{family === 'web-search' && (
				<details className='space-y-3 rounded-lg border p-3'>
					<summary className='cursor-pointer font-medium'>
						{t(toolsPrefix + 'guide')}
					</summary>
					<div className='space-y-4'>
						{props.state.providers.map((provider) => (
							<article key={provider.provider} className='space-y-2 text-sm'>
								<h3 className='font-medium'>
									{t(toolProviderLabelKey(family, provider.provider))} ·{' '}
									{t(
										toolsPrefix +
											'webSearch.providerGuide.items.' +
											provider.provider +
											'.badge'
									)}
								</h3>
								<p>
									{t(
										toolsPrefix +
											'webSearch.providerGuide.items.' +
											provider.provider +
											'.summary'
									)}
								</p>
								<p>
									{t(
										toolsPrefix +
											'webSearch.providerGuide.items.' +
											provider.provider +
											'.sources'
									)}
								</p>
								<p>
									{t(
										toolsPrefix +
											'webSearch.providerGuide.items.' +
											provider.provider +
											'.bestFor'
									)}
								</p>
							</article>
						))}
					</div>
				</details>
			)}
		</section>
	)
}
