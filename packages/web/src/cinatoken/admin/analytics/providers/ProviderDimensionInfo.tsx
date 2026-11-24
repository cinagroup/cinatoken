/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import type { AnalyticsProviderDirectory } from './analytics-provider-directory'
import { providerDimension } from './provider-dimensions'
import { useProviderDimensionLabels } from './use-provider-dimension-labels'

const prefix = 'cinatoken.adminModelAnalytics.'
export function ProviderDimensionInfo(props: {
	providerId: string
	directory?: AnalyticsProviderDirectory
	locale: string
}) {
	const { t } = useTranslation()
	const labels = useProviderDimensionLabels()
	const dimension = providerDimension(
		props.providerId,
		props.directory ?? { status: 'unavailable' },
		props.locale,
		labels
	)
	return (
		<div className='flex max-w-60 min-w-24 flex-col gap-1 break-words'>
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
		</div>
	)
}
