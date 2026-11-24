/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type { AnalyticsProviderDirectory } from './analytics-provider-directory'
import type { ProviderDimension } from './provider-dimensions'

const prefix = 'cinatoken.adminModelAnalytics.'
export function ProviderDirectoryControls(props: {
	directory: AnalyticsProviderDirectory
	isFetching: boolean
	onRetry: () => void
	filter?: {
		value: string
		onChange: (value: string) => void
		dimensions: ReadonlyMap<string, ProviderDimension>
	}
}) {
	const { t, i18n } = useTranslation()
	const options = [
		...new Map(
			[...(props.filter?.dimensions.values() ?? [])]
				.filter((item) => item.status !== 'unavailable')
				.map((item) => [item.key, item])
		).values(),
	].sort(
		(a, b) =>
			a.label.localeCompare(b.label, i18n.resolvedLanguage ?? 'en') ||
			a.key.localeCompare(b.key)
	)
	const statusKey = {
		loading: 'directoryLoading',
		unavailable: 'directoryUnavailable',
		ready: 'directoryReady',
	}[props.directory.status]
	return (
		<section
			aria-label={t(prefix + 'directoryTitle')}
			className='bg-card flex min-w-0 flex-col gap-3 rounded-xl border p-4'
		>
			<div className='flex flex-wrap items-end gap-3'>
				{props.filter && (
					<>
						<label className='grid w-full min-w-0 gap-1 text-sm sm:max-w-sm sm:flex-1'>
							{t(prefix + 'provider_kind')}
							<select
								className='border-input bg-background h-9 min-w-0 rounded-md border px-3 text-sm'
								value={props.filter.value}
								onChange={(event) => props.filter?.onChange(event.target.value)}
							>
								<option value=''>{t(prefix + 'directoryAllKinds')}</option>
								{props.filter.value &&
									!options.some(
										(option) => option.key === props.filter?.value
									) && (
										<option value={props.filter.value}>
											{t(prefix + 'directorySelectedUnavailable')}
										</option>
									)}
								{options.map((option) => (
									<option key={option.key} value={option.key}>
										{option.label}
									</option>
								))}
							</select>
						</label>
						<Button
							type='button'
							size='sm'
							variant='outline'
							disabled={!props.filter.value}
							onClick={() => props.filter?.onChange('')}
						>
							{t(prefix + 'directoryClearKind')}
						</Button>
					</>
				)}
				<Button
					type='button'
					size='sm'
					variant='outline'
					disabled={props.isFetching}
					onClick={props.onRetry}
				>
					{t(prefix + 'directoryRetry')}
				</Button>
			</div>
			<p role='status' className='text-muted-foreground text-xs'>
				{t(prefix + statusKey)}
			</p>
			<p className='text-muted-foreground text-xs'>
				{t(prefix + 'directoryHint')}
			</p>
		</section>
	)
}
