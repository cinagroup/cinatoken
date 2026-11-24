/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type { AnalyticsProviderDirectory } from '../analytics/providers/analytics-provider-directory'

const prefix = 'cinatoken.adminReliability.'
export function ReliabilityDirectoryStatus(props: {
	directory: AnalyticsProviderDirectory
	retry: () => void
	loading: boolean
	canRetry: boolean
}) {
	const { t } = useTranslation()
	const key = {
		ready: 'directoryReady',
		loading: 'directoryLoading',
		unavailable: 'directoryUnavailable',
	}[props.directory.status]
	return (
		<section
			aria-label={t(prefix + 'directoryTitle')}
			className='bg-card min-w-0 space-y-2 rounded-xl border p-4 text-sm'
		>
			<div className='flex flex-wrap items-center justify-between gap-3'>
				<p role='status'>{t(prefix + key)}</p>
				<Button
					type='button'
					variant='outline'
					size='sm'
					onClick={props.retry}
					disabled={props.loading || !props.canRetry}
				>
					{t(prefix + 'directoryRetry')}
				</Button>
			</div>
			<p className='text-muted-foreground text-xs'>
				{t(prefix + 'directoryHint')}
			</p>
		</section>
	)
}
