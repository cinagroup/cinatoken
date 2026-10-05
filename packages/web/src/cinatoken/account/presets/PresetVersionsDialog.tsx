import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import type { PresetRequestOptions, PresetsApi } from '../../preset-api'
import type { PresetVersion, RequestPreset } from '../../preset-contracts'
import { formatAccountDate } from '../key-display'
import { presetAccessFailure, presetErrorKey } from './preset-errors'

const prefix = 'cinatoken.presets.'
export function PresetVersionsDialog(props: {
	api: PresetsApi
	row: RequestPreset
	options: PresetRequestOptions
	queryKey: readonly unknown[]
	disabled: boolean
	onCopy: (version: PresetVersion) => void
	onDesignate: (version: PresetVersion) => void
	onRetry: () => void
	onClose: () => void
}) {
	const { t, i18n } = useTranslation()
	const query = useQuery({
		queryKey: [...props.queryKey, 'versions', props.row.id, props.options],
		queryFn: ({ signal }) =>
			props.api.presetVersions(props.row.id, { ...props.options, signal }),
		retry: false,
		staleTime: 0,
		refetchOnWindowFocus: false,
	})
	const blocked = presetAccessFailure(query.error)
	const versions = [...(query.data?.data ?? [])].sort(
		(left, right) => right.version - left.version
	)
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) props.onClose()
			}}
		>
			<DialogContent
				className='max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl'
				showCloseButton={false}
			>
				<DialogHeader>
					<DialogTitle>
						{t(prefix + 'versionHistory', { name: props.row.name })}
					</DialogTitle>
					<DialogDescription>
						{t(prefix + 'versionSummary', {
							active: props.row.designatedVersion,
							latest: props.row.latestVersion,
						})}
					</DialogDescription>
				</DialogHeader>
				{query.isPending && <p role='status'>{t(prefix + 'loading')}</p>}
				{query.isError && (
					<div role='alert' className='space-y-2'>
						<p className='text-destructive text-sm'>
							{t(presetErrorKey(query.error))}
						</p>
						<Button
							variant='outline'
							disabled={query.isFetching}
							onClick={blocked ? props.onRetry : () => void query.refetch()}
						>
							{t(prefix + 'retry')}
						</Button>
					</div>
				)}
				{!blocked && query.data && (
					<div className='space-y-3'>
						{versions.length === 0 && (
							<p className='text-muted-foreground text-sm'>
								{t(prefix + 'emptyVersions')}
							</p>
						)}
						{versions.map((version) => (
							<article
								key={version.id}
								className='space-y-3 rounded-lg border p-4'
							>
								<div className='flex flex-wrap items-center gap-2'>
									<h3 className='font-medium'>v{version.version}</h3>
									{version.version === props.row.designatedVersion && (
										<Badge>{t(prefix + 'designatedBadge')}</Badge>
									)}
									{version.version === props.row.latestVersion && (
										<Badge variant='secondary'>
											{t(prefix + 'latestBadge')}
										</Badge>
									)}
								</div>
								<p className='text-muted-foreground text-xs break-all'>
									{t(prefix + 'createdAt')}:{' '}
									{formatAccountDate(
										version.createdAt,
										i18n.resolvedLanguage ?? 'en'
									)}{' '}
									· {t(prefix + 'creator')}:{' '}
									{version.createdByUserId ?? t(prefix + 'unknown')}
								</p>
								<details className='text-sm'>
									<summary className='cursor-pointer'>
										{t(prefix + 'versionConfig')}
									</summary>
									<pre className='bg-muted mt-3 max-h-80 overflow-auto rounded-lg p-3 text-xs break-all whitespace-pre-wrap'>
										{JSON.stringify(
											{
												systemPrompt: version.systemPrompt,
												config: version.config,
											},
											null,
											2
										)}
									</pre>
									{version.config === null && (
										<p className='text-destructive mt-2 text-xs'>
											{t(prefix + 'configUnavailable')}
										</p>
									)}
								</details>
								<div className='flex flex-wrap gap-2'>
									<Button
										variant='outline'
										disabled={
											props.disabled ||
											query.isError ||
											query.isFetching ||
											props.row.status === 'archived' ||
											version.config === null
										}
										onClick={() => props.onCopy(version)}
									>
										{t(prefix + 'copyVersion')}
									</Button>
									<Button
										disabled={
											props.disabled ||
											query.isError ||
											query.isFetching ||
											props.row.status === 'archived' ||
											version.version === props.row.designatedVersion
										}
										onClick={() => props.onDesignate(version)}
									>
										{t(prefix + 'selectVersion')}
									</Button>
								</div>
							</article>
						))}
					</div>
				)}
				<Button variant='outline' onClick={props.onClose}>
					{t(prefix + 'close')}
				</Button>
			</DialogContent>
		</Dialog>
	)
}
