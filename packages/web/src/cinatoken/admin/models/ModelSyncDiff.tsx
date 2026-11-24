/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '../../../components/ui/badge'
import { Checkbox } from '../../../components/ui/checkbox'
import {
	Field,
	FieldContent,
	FieldGroup,
	FieldLabel,
	FieldLegend,
	FieldSet,
} from '../../../components/ui/field'
import type {
	ModelSyncEntry,
	ModelSyncField,
	ModelSyncReport,
} from '../model-contracts'
import { modelSyncSelectionKey } from './model-sync-domain'

const prefix = 'cinatoken.adminModels.'
function SyncField(props: {
	model: ModelSyncEntry
	field: ModelSyncField
	selected: boolean
	disabled: boolean
	onToggle: (key: string, checked: boolean) => void
}) {
	const { t } = useTranslation()
	const id = useId()
	const field = props.field
	return (
		<div className='flex min-w-0 flex-col gap-3 rounded-lg border p-3'>
			<Field orientation='horizontal' data-disabled={props.disabled}>
				<Checkbox
					id={id}
					checked={props.selected}
					disabled={props.disabled}
					onCheckedChange={(checked) =>
						props.onToggle(
							modelSyncSelectionKey(props.model.model_id, field.key),
							checked
						)
					}
				/>
				<FieldContent>
					<FieldLabel htmlFor={id} className='break-all'>
						{t(prefix + field.key)} · {props.model.model_id}
					</FieldLabel>
					<Badge variant='secondary'>
						{t(prefix + 'syncStatus_' + field.status)}
					</Badge>
				</FieldContent>
			</Field>
			{field.key === 'pricing_profile' ? (
				<div className='flex min-w-0 flex-col gap-2'>
					<p className='text-muted-foreground text-xs'>
						{t(prefix + 'syncPricingHint')}
					</p>
					<div className='max-h-80 overflow-auto'>
						<table className='w-full text-left text-xs'>
							<thead>
								<tr>
									<th className='p-2'>{t(prefix + 'syncPricingPath')}</th>
									<th className='p-2'>{t(prefix + 'syncCurrent')}</th>
									<th className='p-2'>{t(prefix + 'syncOfficial')}</th>
								</tr>
							</thead>
							<tbody>
								{field.rows.map((row) => (
									<tr key={row.path} className='border-t align-top'>
										<td className='p-2'>
											<code className='break-all'>{row.path}</code>
											<p>{t(prefix + 'syncStatus_' + row.status)}</p>
										</td>
										<td className='max-w-72 p-2 break-all whitespace-pre-wrap'>
											{row.current ?? '—'}
										</td>
										<td className='max-w-72 p-2 break-all whitespace-pre-wrap'>
											{row.official ?? '—'}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</div>
			) : (
				<dl className='grid min-w-0 gap-3 text-xs sm:grid-cols-2'>
					<div className='min-w-0'>
						<dt className='text-muted-foreground'>
							{t(prefix + 'syncCurrent')}
						</dt>
						<dd className='mt-1 max-h-48 overflow-auto break-words whitespace-pre-wrap'>
							{field.current ?? '—'}
						</dd>
					</div>
					<div className='min-w-0'>
						<dt className='text-muted-foreground'>
							{t(prefix + 'syncOfficial')}
						</dt>
						<dd className='mt-1 max-h-48 overflow-auto break-words whitespace-pre-wrap'>
							{field.official}
						</dd>
					</div>
				</dl>
			)}
		</div>
	)
}

export function ModelSyncDiff(props: {
	groups: ModelSyncReport['groups']
	selection: readonly string[]
	disabled: boolean
	onToggle: (key: string, checked: boolean) => void
}) {
	const { t } = useTranslation()
	const selected = new Set(props.selection)
	return (
		<div className='flex min-w-0 flex-col gap-5'>
			{props.groups.map((group) => (
				<section
					key={group.vendor}
					className='flex min-w-0 flex-col gap-3'
					aria-label={group.vendor_label}
				>
					<h3 className='text-lg font-medium break-words'>
						{group.vendor_label}
					</h3>
					{group.models.map((model) => (
						<article
							key={model.model_id}
							className='min-w-0 rounded-xl border p-4'
						>
							<FieldSet disabled={props.disabled}>
								<FieldLegend className='break-words'>
									{model.display_name ?? model.model_id}
								</FieldLegend>
								<p className='text-muted-foreground text-xs break-all'>
									{model.model_id} · {t(prefix + model.kind)} ·{' '}
									{t(prefix + 'routeCounts', {
										active: model.active_routes_count,
										total: model.routes_count,
									})}
								</p>
								<FieldGroup>
									{model.fields.map((field) => (
										<SyncField
											key={field.key}
											model={model}
											field={field}
											selected={selected.has(
												modelSyncSelectionKey(model.model_id, field.key)
											)}
											disabled={props.disabled}
											onToggle={props.onToggle}
										/>
									))}
								</FieldGroup>
							</FieldSet>
						</article>
					))}
				</section>
			))}
		</div>
	)
}
