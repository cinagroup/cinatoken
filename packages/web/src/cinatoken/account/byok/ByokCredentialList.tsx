import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import type { ByokKey } from '../../byok-contracts'
import { orderedByokKeys } from './byok-form-schema'

function RestrictionCount(props: { label: string; values: string[] | null }) {
	const { t } = useTranslation()
	let value = t('cinatoken.account.byok.any')
	if (props.values !== null)
		value = t('cinatoken.account.byok.restrictionCount', {
			count: props.values.length,
		})
	if (props.values?.length === 0) value = t('cinatoken.account.byok.noValues')
	return (
		<div>
			<dt className='text-muted-foreground text-xs'>{t(props.label)}</dt>
			<dd className='mt-1 text-sm'>{value}</dd>
		</div>
	)
}

export function ByokCredentialList(props: {
	rows: ByokKey[]
	disabled: boolean
	onDetails: (row: ByokKey) => void
	onEdit: (row: ByokKey) => void
	onRemove: (row: ByokKey) => void
	onToggle: (row: ByokKey) => void
	onOrder: (provider: string) => void
}) {
	const { t } = useTranslation()
	const groups = useMemo(() => {
		const map = new Map<string, ByokKey[]>()
		for (const row of props.rows) {
			const group = map.get(row.provider) ?? []
			group.push(row)
			map.set(row.provider, group)
		}
		return [...map.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([provider, rows]) => ({ provider, rows: orderedByokKeys(rows) }))
	}, [props.rows])
	return (
		<div className='space-y-6'>
			{groups.map((group) => (
				<section
					key={group.provider}
					aria-labelledby={'provider-' + group.provider}
					className='space-y-3'
				>
					<div className='flex flex-wrap items-center justify-between gap-3'>
						<div>
							<h2 id={'provider-' + group.provider} className='font-semibold'>
								{group.provider}
							</h2>
							<p className='text-muted-foreground text-xs'>
								{t('cinatoken.account.byok.groupCount', {
									count: group.rows.length,
								})}
							</p>
						</div>
						<Button
							variant='outline'
							size='sm'
							disabled={props.disabled}
							onClick={() => props.onOrder(group.provider)}
						>
							{t('cinatoken.account.byok.reorder')}
						</Button>
					</div>
					<div className='grid gap-3 xl:grid-cols-2'>
						{group.rows.map((row) => {
							let policy = 'cinatoken.account.byok.allow'
							if (row.always_use_for_provider)
								policy = 'cinatoken.account.byok.providerPolicy'
							else if (row.always_use_for_matching_models)
								policy = 'cinatoken.account.byok.matching_models'
							return (
								<Card key={row.id}>
									<CardContent className='space-y-4 p-4'>
										<div className='flex items-start justify-between gap-3'>
											<div className='min-w-0'>
												<h3 className='font-medium break-all'>
													{row.name || t('cinatoken.account.byok.unnamed')}
												</h3>
												<code className='text-muted-foreground mt-1 block text-xs'>
													{row.label}
												</code>
											</div>
											<Badge variant={row.disabled ? 'secondary' : 'outline'}>
												{t(
													row.disabled
														? 'cinatoken.account.byok.disabled'
														: 'cinatoken.account.byok.enabled'
												)}
											</Badge>
										</div>
										<div className='flex flex-wrap gap-2'>
											<Badge variant='secondary'>
												{t(
													row.is_fallback
														? 'cinatoken.account.byok.fallback'
														: 'cinatoken.account.byok.primary'
												)}
											</Badge>
											<span className='text-muted-foreground text-xs leading-5'>
												{t(policy)}
											</span>
										</div>
										<dl className='grid gap-3 border-y py-3 sm:grid-cols-3'>
											<RestrictionCount
												label='cinatoken.account.byok.models'
												values={row.allowed_models}
											/>
											<RestrictionCount
												label='cinatoken.account.byok.users'
												values={row.allowed_user_ids}
											/>
											<RestrictionCount
												label='cinatoken.account.byok.gatewayKeys'
												values={row.allowed_api_key_hashes}
											/>
										</dl>
										<div className='flex flex-wrap gap-2'>
											<Button
												variant='outline'
												size='sm'
												disabled={props.disabled}
												onClick={() => props.onDetails(row)}
											>
												{t('cinatoken.account.byok.details')}
											</Button>
											<Button
												variant='outline'
												size='sm'
												disabled={props.disabled}
												onClick={() => props.onEdit(row)}
											>
												{t('cinatoken.account.byok.edit')}
											</Button>
											<Button
												variant='ghost'
												size='sm'
												disabled={props.disabled}
												onClick={() => props.onToggle(row)}
											>
												{t(
													row.disabled
														? 'cinatoken.account.byok.enable'
														: 'cinatoken.account.byok.disable'
												)}
											</Button>
											<Button
												variant='ghost'
												size='sm'
												className='text-destructive'
												disabled={props.disabled}
												onClick={() => props.onRemove(row)}
											>
												{t('cinatoken.account.byok.remove')}
											</Button>
										</div>
									</CardContent>
								</Card>
							)
						})}
					</div>
				</section>
			))}
		</div>
	)
}
