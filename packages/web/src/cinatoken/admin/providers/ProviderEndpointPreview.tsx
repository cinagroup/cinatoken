/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import {
	summarizeProviderEndpoints,
	type ProviderEndpointSource,
} from './provider-endpoint-summary'

const prefix = 'cinatoken.adminProviders.'

export function ProviderEndpointPreview(props: {
	source: ProviderEndpointSource
}) {
	const { t } = useTranslation()
	const summary = summarizeProviderEndpoints(props.source)
	if (summary.state !== 'available')
		return (
			<span className='text-muted-foreground block text-xs break-words'>
				{t(prefix + 'templateEndpointsUnavailable')}
			</span>
		)
	if (summary.entries.length === 0)
		return (
			<span className='text-muted-foreground block text-xs'>
				{t(prefix + 'templateEndpointsEmpty')}
			</span>
		)
	return (
		<span className='block space-y-2' aria-label={t(prefix + 'endpoints')}>
			{summary.entries.map((entry) => (
				<span
					key={entry.protocol + ':' + entry.capability}
					className='block space-y-1 border-t pt-2 text-xs'
				>
					<span className='block font-medium'>
						{entry.protocol} ·{' '}
						{entry.capability === 'base'
							? t(prefix + 'baseUrl', { protocol: entry.protocol })
							: entry.capability}
					</span>
					<span className='text-muted-foreground block font-mono break-all'>
						{entry.url}
					</span>
				</span>
			))}
		</span>
	)
}
