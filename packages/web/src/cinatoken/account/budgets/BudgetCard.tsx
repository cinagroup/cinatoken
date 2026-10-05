import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type {
	WorkspaceBudget,
	WorkspaceBudgetInterval,
} from '../../workspace-budget-contracts'

export function BudgetCard(props: {
	interval: WorkspaceBudgetInterval
	row?: WorkspaceBudget
	currency: string
	canManage: boolean
	pending: boolean
	draft: string
	invalid: boolean
	onDraft: (value: string) => void
	onSave: () => void
	onRemove: () => void
}) {
	const { t, i18n } = useTranslation()
	const label = t('cinatoken.workspaceBudgets.intervals.' + props.interval)
	const money = new Intl.NumberFormat(i18n.resolvedLanguage, {
		style: 'currency',
		currency: props.currency,
		currencyDisplay: 'code',
		maximumFractionDigits: 6,
	})
	const date = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
		dateStyle: 'medium',
		timeStyle: 'short',
		timeZone: 'UTC',
	})
	const row = props.row
	const inputId = 'workspace-budget-' + props.interval
	return (
		<Card>
			<CardContent className='space-y-4 p-4'>
				<h3 className='font-semibold'>{label}</h3>
				<p className='text-xl font-semibold break-all'>
					{row
						? money.format(row.limitUsd)
						: t('cinatoken.workspaceBudgets.notConfigured')}
				</p>
				{row && (
					<>
						<progress
							className='h-2 w-full'
							max={row.limitUsd}
							value={Math.min(row.limitUsd, row.spentUsd + row.reservedUsd)}
							aria-label={t('cinatoken.workspaceBudgets.usage', {
								interval: label,
							})}
						/>
						<dl className='grid grid-cols-3 gap-2 text-xs'>
							{(['spent', 'reserved', 'remaining'] as const).map((field) => (
								<div key={field} className='min-w-0'>
									<dt className='text-muted-foreground'>
										{t('cinatoken.workspaceBudgets.' + field)}
									</dt>
									<dd className='mt-1 font-medium break-all'>
										{money.format(
											row[
												(field + 'Usd') as
													'spentUsd' | 'reservedUsd' | 'remainingUsd'
											]
										)}
									</dd>
								</div>
							))}
						</dl>
						<p className='text-muted-foreground text-xs leading-5'>
							{t(
								props.interval === 'lifetime'
									? 'cinatoken.workspaceBudgets.since'
									: 'cinatoken.workspaceBudgets.period',
								{
									start: date.format(new Date(row.periodStart)),
									end: date.format(new Date(row.periodEnd)),
								}
							)}
						</p>
					</>
				)}
				{props.canManage && (
					<form
						className='space-y-3'
						onSubmit={(event) => {
							event.preventDefault()
							props.onSave()
						}}
					>
						<Label htmlFor={inputId}>
							{t('cinatoken.workspaceBudgets.limitLabel', {
								interval: label,
								currency: props.currency,
							})}
						</Label>
						<Input
							id={inputId}
							inputMode='decimal'
							autoComplete='off'
							value={props.draft}
							placeholder={row ? String(row.limitUsd) : undefined}
							disabled={props.pending}
							aria-invalid={props.invalid}
							aria-describedby={props.invalid ? inputId + '-error' : undefined}
							onChange={(event) => props.onDraft(event.target.value)}
						/>
						{props.invalid && (
							<p
								id={inputId + '-error'}
								role='alert'
								className='text-destructive text-xs'
							>
								{t('cinatoken.workspaceBudgets.invalid')}
							</p>
						)}
						<div className='flex flex-wrap gap-2'>
							<Button
								size='sm'
								type='submit'
								disabled={props.pending || !props.draft.trim()}
							>
								{t(
									props.pending
										? 'cinatoken.workspaceBudgets.saving'
										: 'cinatoken.workspaceBudgets.save'
								)}
							</Button>
							{row && (
								<Button
									size='sm'
									type='button'
									variant='outline'
									disabled={props.pending}
									onClick={props.onRemove}
								>
									{t('cinatoken.workspaceBudgets.remove')}
								</Button>
							)}
						</div>
					</form>
				)}
			</CardContent>
		</Card>
	)
}
