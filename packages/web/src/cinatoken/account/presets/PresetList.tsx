import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { RequestPreset } from '../../preset-contracts'
import { formatAccountDate } from '../key-display'
import type { PresetChange } from './use-presets-manager'

const prefix = 'cinatoken.presets.'
export function PresetList(props: {
	rows: RequestPreset[]
	disabled: boolean
	onEdit: (row: RequestPreset) => void
	onMetadata: (row: RequestPreset) => void
	onHistory: (row: RequestPreset) => void
	onChange: (change: PresetChange) => void
}) {
	const { t, i18n } = useTranslation()
	return (
		<div className='grid gap-4 lg:grid-cols-2'>
			{props.rows.map((row) => (
				<Card key={row.id} className='min-w-0 gap-4'>
					<CardHeader className='space-y-2'>
						<div className='flex flex-wrap items-center justify-between gap-2'>
							<CardTitle className='min-w-0 text-lg break-all'>
								{row.name}
							</CardTitle>
							<div className='flex flex-wrap gap-2'>
								<Badge
									variant={row.status === 'active' ? 'secondary' : 'outline'}
								>
									{t(prefix + row.status)}
								</Badge>
								<Badge variant='outline'>{t(prefix + row.visibility)}</Badge>
							</div>
						</div>
						<p className='text-muted-foreground font-mono text-xs break-all'>
							@preset/{row.slug}
						</p>
						<p className='text-muted-foreground text-sm break-all'>
							{row.description ?? t(prefix + 'noDescription')}
						</p>
					</CardHeader>
					<CardContent className='space-y-4'>
						<div className='flex flex-wrap gap-2'>
							<Badge>
								{t(prefix + 'designated', { version: row.designatedVersion })}
							</Badge>
							<Badge variant='secondary'>
								{t(prefix + 'latest', { version: row.latestVersion })}
							</Badge>
						</div>
						{typeof row.config?.model === 'string' && (
							<p className='text-sm break-all'>
								{t(prefix + 'model')}: {row.config.model}
							</p>
						)}
						{row.config === null && (
							<p className='text-destructive text-xs'>
								{t(prefix + 'configUnavailable')}
							</p>
						)}
						<p className='text-muted-foreground text-xs'>
							{formatAccountDate(row.updatedAt, i18n.resolvedLanguage ?? 'en')}
						</p>
						<div className='flex flex-wrap gap-2'>
							<Button
								disabled={props.disabled || row.status === 'archived'}
								onClick={() => props.onEdit(row)}
							>
								{t(prefix + 'newVersion')}
							</Button>
							<Button
								variant='outline'
								disabled={props.disabled}
								onClick={() => props.onHistory(row)}
							>
								{t(prefix + 'versions')}
							</Button>
							<Button
								variant='outline'
								disabled={props.disabled}
								onClick={() => props.onMetadata(row)}
							>
								{t(prefix + 'editMetadata')}
							</Button>
							<Button
								variant='outline'
								disabled={props.disabled}
								onClick={() =>
									props.onChange({
										row,
										kind: row.visibility === 'public' ? 'private' : 'public',
									})
								}
							>
								{t(
									prefix +
										(row.visibility === 'public' ? 'makePrivate' : 'makePublic')
								)}
							</Button>
							<Button
								variant={row.status === 'active' ? 'destructive' : 'outline'}
								disabled={props.disabled}
								onClick={() =>
									props.onChange({
										row,
										kind: row.status === 'active' ? 'archive' : 'restore',
									})
								}
							>
								{t(prefix + (row.status === 'active' ? 'archive' : 'restore'))}
							</Button>
						</div>
					</CardContent>
				</Card>
			))}
		</div>
	)
}
