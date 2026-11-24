/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import type { AnalyticsProviderDirectory } from '../analytics/providers/analytics-provider-directory'
import { providerDimension } from '../analytics/providers/provider-dimensions'

const prefix = 'cinatoken.adminReliability.'
export function ReliabilityProviderKind(props: {
	id: string | null
	directory: AnalyticsProviderDirectory
	locale: string
}) {
	const { t } = useTranslation()
	if (!props.id) return <span>{t(prefix + 'noValue')}</span>
	const dimension = providerDimension(props.id, props.directory, props.locale, {
		unclassified: t(prefix + 'kindUnclassified'),
		custom: t(prefix + 'kindCustom'),
		unknown: t(prefix + 'kindUnknown'),
		unavailable: t(prefix + 'kindUnavailable'),
		rest: t(prefix + 'kindRest'),
		mcp: t(prefix + 'kindMcp'),
	})
	return (
		<span className='flex min-w-28 flex-col gap-1 break-words'>
			<span>{dimension.label}</span>
			{dimension.status === 'missing' && (
				<span className='text-muted-foreground text-xs'>
					{t(prefix + 'directoryMissing')}
				</span>
			)}
			{dimension.status === 'virtual' && (
				<span className='text-muted-foreground text-xs'>
					{t(prefix + 'directoryVirtual')}
				</span>
			)}
		</span>
	)
}

export function ReliabilityProviderAccount(props: {
	id: string | null
	name: string | null
	directory: AnalyticsProviderDirectory
}) {
	const { t } = useTranslation()
	const current =
		props.directory.status === 'ready' && props.id
			? props.directory.providers.get(props.id)
			: undefined
	const name =
		current?.name.trim() || props.name || props.id || t(prefix + 'noValue')
	return (
		<span className='flex min-w-40 flex-col gap-1 break-all'>
			<span className='font-medium'>{name}</span>
			{props.id && props.id !== name && (
				<span className='text-muted-foreground font-mono text-xs'>
					{props.id}
				</span>
			)}
		</span>
	)
}
