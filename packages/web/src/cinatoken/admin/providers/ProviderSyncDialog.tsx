/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription } from '../../../components/ui/alert'
import { Button } from '../../../components/ui/button'
import { Checkbox } from '../../../components/ui/checkbox'
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
} from '../../../components/ui/dialog'
import {
	Field,
	FieldGroup,
	FieldLabel,
	FieldLegend,
	FieldSet,
	FieldDescription,
} from '../../../components/ui/field'
import {
	NativeSelect,
	NativeSelectOption,
} from '../../../components/ui/native-select'
import type { ProvidersApi, ProviderRequestOptions } from '../provider-api'
import type {
	ProviderSyncField,
	ProviderSyncItems,
	ProviderSyncReport,
	ProviderSyncResult,
} from './provider-compatibility'
import { providerErrorKey } from './provider-errors'

const prefix = 'cinatoken.adminProviders.'
type Props = {
	api: ProvidersApi
	queryPrefix: readonly unknown[]
	readOptions?: (signal?: AbortSignal) => ProviderRequestOptions
	disabled: boolean
	pending: boolean
	error: unknown
	result: ProviderSyncResult | null
	migrated: boolean
	onFresh: () => void
	onApply: (items: ProviderSyncItems) => void
	onMigrate: (id: string, kind: string) => void
	onClose: () => void
}
export function ProviderSyncDialog(props: Props) {
	const { t } = useTranslation(),
		[version, setVersion] = useState(0)
	const query = useQuery({
		queryKey: [...props.queryPrefix, 'sync'],
		queryFn: ({ signal }) =>
			props.api.providerSyncReport(props.readOptions?.(signal) ?? { signal }),
		retry: false,
		refetchOnWindowFocus: false,
		staleTime: 0,
	})
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !props.pending) props.onClose()
			}}
		>
			<DialogContent
				className='max-h-[92dvh] overflow-y-auto sm:max-w-4xl'
				showCloseButton={false}
			>
				<DialogHeader>
					<DialogTitle>{t(prefix + 'sync')}</DialogTitle>
					<DialogDescription>
						{t(prefix + 'syncHint')} {t(prefix + 'syncRecalculated')}
					</DialogDescription>
				</DialogHeader>
				{query.isFetching && <p role='status'>{t(prefix + 'loading')}</p>}
				{(query.error || props.error) != null && (
					<Alert>
						<AlertDescription>
							{t(providerErrorKey(query.error ?? props.error))}
						</AlertDescription>
					</Alert>
				)}
				{props.result && (
					<Alert>
						<AlertDescription>
							<p role='status'>
								{t(prefix + 'syncResult', {
									updated: props.result.updated,
									skipped: props.result.skipped,
									failed: props.result.failed.length,
								})}
							</p>
							{props.result.failed.map((failure) => (
								<p key={failure.provider_id}>
									{t(prefix + 'syncFailedItem', { id: failure.provider_id })}
								</p>
							))}
						</AlertDescription>
					</Alert>
				)}
				{props.migrated && <p role='status'>{t(prefix + 'syncMigrated')}</p>}
				{query.data && !query.error && (
					<ProviderSyncReview
						key={JSON.stringify([version, query.data])}
						{...props}
						report={query.data}
						disabled={
							props.disabled ||
							query.isFetching ||
							props.result !== null ||
							props.migrated
						}
					/>
				)}
				<div className='flex flex-wrap justify-end gap-2'>
					<Button
						type='button'
						variant='outline'
						disabled={props.pending || query.isFetching}
						onClick={() => {
							props.onFresh()
							setVersion((value) => value + 1)
							void query.refetch()
						}}
					>
						{t(prefix + 'syncRecheck')}
					</Button>
					<Button
						type='button'
						variant='outline'
						disabled={props.pending}
						onClick={props.onClose}
					>
						{t(prefix + 'close')}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	)
}
function Difference(props: { field: ProviderSyncField }) {
	const { t } = useTranslation(),
		field = props.field
	const rows =
		'rows' in field
			? field.rows
			: [
					{
						slot: 'description',
						current: field.current,
						official: field.official,
						status: field.status,
					},
				]
	return (
		<dl className='flex min-w-0 flex-col gap-2 text-xs'>
			{rows.map((row) => (
				<div
					key={row.slot}
					className='grid min-w-0 gap-2 rounded-md border p-3 sm:grid-cols-2'
				>
					<dt className='font-medium break-all sm:col-span-2'>
						{row.slot} · {t(prefix + row.status)}
					</dt>
					<dd className='min-w-0 break-all'>
						<span className='text-muted-foreground'>
							{t(prefix + 'current')}:{' '}
						</span>
						{row.current ?? '—'}
					</dd>
					<dd className='min-w-0 break-all'>
						<span className='text-muted-foreground'>
							{t(prefix + 'official')}:{' '}
						</span>
						{row.official ?? '—'}
					</dd>
				</div>
			))}
		</dl>
	)
}
export function ProviderSyncReview(
	props: Props & { report: ProviderSyncReport }
) {
	const { t, i18n } = useTranslation(),
		[selection, setSelection] = useState<Map<string, string[]>>(
			() => new Map()
		),
		[confirmed, setConfirmed] = useState(false),
		[kinds, setKinds] = useState<Map<string, string>>(() => new Map())
	const items = [...selection.entries()]
		.filter(([, fields]) => fields.length > 0)
		.map(([provider_id, fields]) => ({
			provider_id,
			fields,
		})) as ProviderSyncItems
	function choose(id: string, key: string, checked: boolean) {
		setConfirmed(false)
		setSelection((previous) => {
			const next = new Map(previous)
			const values = previous.get(id) ?? []
			next.set(
				id,
				checked
					? [...new Set([...values, key])]
					: values.filter((value) => value !== key)
			)
			return next
		})
	}
	return (
		<div className='flex min-w-0 flex-col gap-5'>
			{props.report.groups.length === 0 &&
				props.report.orphans.length === 0 && <p>{t(prefix + 'syncEmpty')}</p>}
			{props.report.groups.map((group) => (
				<section key={group.kind} className='flex min-w-0 flex-col gap-3'>
					<h3 className='font-semibold'>
						{i18n.resolvedLanguage?.startsWith('zh')
							? group.label_zh
							: group.label_en}
					</h3>
					{group.providers.map((provider) => (
						<FieldSet
							key={provider.provider_id}
							disabled={props.disabled}
							className='min-w-0 rounded-lg border p-4'
						>
							<FieldLegend>{provider.provider_name}</FieldLegend>
							<FieldDescription>
								{provider.provider_id} ·{' '}
								{t(prefix + 'routes', {
									active: provider.active_routes_count,
									total: provider.routes_count,
								})}
							</FieldDescription>
							<FieldGroup className='gap-4'>
								{provider.fields.map((field) => (
									<Field key={field.key} className='min-w-0'>
										<Field orientation='horizontal'>
											<Checkbox
												id={JSON.stringify([provider.provider_id, field.key])}
												checked={
													selection
														.get(provider.provider_id)
														?.includes(field.key) ?? false
												}
												disabled={props.disabled}
												onCheckedChange={(checked) =>
													choose(
														provider.provider_id,
														field.key,
														checked === true
													)
												}
											/>
											<FieldLabel
												htmlFor={JSON.stringify([
													provider.provider_id,
													field.key,
												])}
											>
												{provider.provider_name} · {field.key} ·{' '}
												{t(prefix + field.status)}
											</FieldLabel>
										</Field>
										<Difference field={field} />
									</Field>
								))}
							</FieldGroup>
						</FieldSet>
					))}
				</section>
			))}
			{props.report.orphans.length > 0 && (
				<FieldSet>
					<FieldLegend>{t(prefix + 'syncOrphans')}</FieldLegend>
					<FieldDescription>{t(prefix + 'syncMigrateHint')}</FieldDescription>
					<FieldGroup>
						{props.report.orphans.map((orphan) => (
							<Field key={orphan.provider_id}>
								<FieldLabel htmlFor={'migrate-' + orphan.provider_id}>
									{orphan.provider_name} · {orphan.kind}
								</FieldLabel>
								{orphan.suggested_kind && (
									<FieldDescription>
										{t(prefix + 'syncSuggested', {
											kind: orphan.suggested_kind,
										})}
									</FieldDescription>
								)}
								<NativeSelect
									id={'migrate-' + orphan.provider_id}
									className='w-full'
									value={kinds.get(orphan.provider_id) ?? ''}
									disabled={props.disabled}
									onChange={(event) =>
										setKinds((previous) =>
											new Map(previous).set(
												orphan.provider_id,
												event.target.value
											)
										)
									}
								>
									<NativeSelectOption value=''>—</NativeSelectOption>
									<NativeSelectOption value='__custom__'>
										{t(prefix + 'kindCustom')}
									</NativeSelectOption>
									{props.report.kind_choices.map((choice) => (
										<NativeSelectOption value={choice.kind} key={choice.kind}>
											{i18n.resolvedLanguage?.startsWith('zh')
												? choice.label_zh
												: choice.label_en}
										</NativeSelectOption>
									))}
								</NativeSelect>
								<Button
									type='button'
									variant='outline'
									disabled={props.disabled || !kinds.get(orphan.provider_id)}
									onClick={() =>
										props.onMigrate(
											orphan.provider_id,
											kinds.get(orphan.provider_id)!
										)
									}
								>
									{t(prefix + 'syncMigrate')}
								</Button>
							</Field>
						))}
					</FieldGroup>
				</FieldSet>
			)}
			{props.report.groups.length > 0 && (
				<>
					<Field orientation='horizontal'>
						<Checkbox
							id='provider-sync-confirm'
							checked={confirmed}
							disabled={props.disabled || items.length === 0}
							onCheckedChange={(value) => setConfirmed(value === true)}
						/>
						<FieldLabel htmlFor='provider-sync-confirm'>
							{t(prefix + 'syncConfirm')}
						</FieldLabel>
					</Field>
					<Button
						type='button'
						disabled={props.disabled || !confirmed || items.length === 0}
						onClick={() => props.onApply(items)}
					>
						{t(prefix + 'syncApply')} ({items.length})
					</Button>
				</>
			)}
		</div>
	)
}
