import { useTranslation } from 'react-i18next'
import { Badge } from '../../../components/ui/badge'
import { Button } from '../../../components/ui/button'
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from '../../../components/ui/card'
import type { AdminProvider } from '../provider-contracts'
import { normalizeProviderEndpoints } from '../provider-endpoints'

const prefix = 'cinatoken.adminProviders.'
export function ProviderList(props: {
	rows: AdminProvider[]
	disabled: boolean
	onDetail: (row: AdminProvider) => void
	onEdit: (row: AdminProvider) => void
	onClone: (row: AdminProvider) => void
	onChange: (row: AdminProvider, action: 'status' | 'delete') => void
}) {
	const { t } = useTranslation()
	return (
		<div className='grid gap-4 lg:grid-cols-2'>
			{props.rows.map((row) => (
				<Card key={row.id} className='min-w-0 gap-4'>
					<CardHeader className='space-y-3'>
						<div className='flex flex-wrap items-start justify-between gap-3'>
							<div className='flex min-w-0 items-center gap-3'>
								<span
									aria-hidden='true'
									className='bg-secondary text-secondary-foreground flex size-10 shrink-0 items-center justify-center rounded-xl font-semibold'
								>
									{row.name.slice(0, 1)}
								</span>
								<div className='min-w-0'>
									<CardTitle className='text-lg break-all'>
										{row.name}
									</CardTitle>
									<p className='text-muted-foreground mt-1 font-mono text-xs break-all'>
										{row.id}
									</p>
								</div>
							</div>
							<Badge
								variant={row.status === 'active' ? 'secondary' : 'outline'}
							>
								{t(prefix + row.status)}
							</Badge>
						</div>
						{row.description && (
							<p className='text-muted-foreground text-sm break-words'>
								{row.description}
							</p>
						)}
					</CardHeader>
					<CardContent className='space-y-4'>
						<div className='flex flex-wrap gap-2'>
							<Badge variant='outline'>{row.vendor_key}</Badge>
							{row.has_pending_key && (
								<Badge variant='outline'>{t(prefix + 'pending')}</Badge>
							)}
							{row.api_key === '(empty)' && (
								<Badge variant='outline'>{t(prefix + 'no_key')}</Badge>
							)}
							{row.shared_channel_type && (
								<Badge variant='outline'>{row.shared_channel_type}</Badge>
							)}
							{row.endpointsState === 'available' &&
								Object.keys(normalizeProviderEndpoints(row.endpoints)).map(
									(protocol) => (
										<Badge key={protocol} variant='outline'>
											{protocol}
										</Badge>
									)
								)}
						</div>
						<p className='font-mono text-sm break-all'>{row.api_key}</p>
						<p className='text-muted-foreground text-xs'>
							{t(prefix + 'routes', {
								active: row.active_routes_count,
								total: row.routes_count,
							})}
						</p>
						{row.endpointsState !== 'available' && (
							<p className='text-muted-foreground rounded-md border p-3 text-xs'>
								{t(
									prefix +
										(row.endpointsState === 'redacted'
											? 'endpointRedacted'
											: 'endpointInvalid')
								)}
							</p>
						)}
						<div className='flex flex-wrap gap-2'>
							<Button
								disabled={props.disabled}
								onClick={() => props.onDetail(row)}
							>
								{t(prefix + 'detail')}
							</Button>
							<Button
								variant='outline'
								disabled={props.disabled}
								onClick={() => props.onEdit(row)}
							>
								{t(prefix + 'edit')}
							</Button>
							<Button
								variant='outline'
								disabled={props.disabled}
								onClick={() => props.onClone(row)}
							>
								{t(prefix + 'clone')}
							</Button>
							<Button
								variant='outline'
								disabled={props.disabled}
								onClick={() => props.onChange(row, 'status')}
							>
								{t(prefix + (row.status === 'active' ? 'disable' : 'enable'))}
							</Button>
							<Button
								variant='destructive'
								disabled={props.disabled}
								onClick={() => props.onChange(row, 'delete')}
							>
								{t(prefix + 'delete')}
							</Button>
						</div>
					</CardContent>
				</Card>
			))}
		</div>
	)
}
