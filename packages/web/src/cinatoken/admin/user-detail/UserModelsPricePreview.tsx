/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription } from '../../../components/ui/alert'
import { Button } from '../../../components/ui/button'
import { Field, FieldGroup, FieldLabel } from '../../../components/ui/field'
import { Input } from '../../../components/ui/input'
import {
	NativeSelect,
	NativeSelectOption,
} from '../../../components/ui/native-select'
import type { AdminDomainRequestOptions } from '../domain-transport'
import { userAccessDenied } from '../users/users-errors'
import type { AdminUserDetailApi } from './user-detail-api'
import {
	defaultUserModelPreviewFilters,
	formatUserModelPreviewFactor,
	type UserModelPreview,
	type UserModelPreviewFilters,
} from './user-factor-preview'

const prefix = 'cinatoken.adminUserDetail.'
export function UserModelsPricePreview(props: {
	api: AdminUserDetailApi
	userId: string
	options: AdminDomainRequestOptions
	dirty: boolean
	blocked: boolean
	onDenied: () => void
}) {
	const { t, i18n } = useTranslation(),
		id = useId(),
		controller = useRef<AbortController | null>(null)
	const [filters, setFilters] = useState(defaultUserModelPreviewFilters),
		[data, setData] = useState<UserModelPreview | null>(null),
		[error, setError] = useState<unknown>(null),
		[busy, setBusy] = useState(false),
		[denied, setDenied] = useState(false)
	useEffect(() => () => controller.current?.abort(), [])
	useEffect(() => {
		if (props.blocked) controller.current?.abort()
	}, [props.blocked])
	function change(patch: Partial<UserModelPreviewFilters>) {
		controller.current?.abort()
		setBusy(false)
		setData(null)
		setError(null)
		setFilters((previous) => ({ ...previous, ...patch }))
	}
	async function load() {
		if (busy || denied || props.blocked) return
		controller.current?.abort()
		const request = new AbortController()
		controller.current = request
		setData(null)
		setError(null)
		setBusy(true)
		try {
			const next = await props.api.userModelPricePreview(
				props.userId,
				filters,
				{ ...props.options, signal: request.signal }
			)
			if (!request.signal.aborted) setData(next)
		} catch (e) {
			if (!request.signal.aborted) {
				setError(e)
				if (userAccessDenied(e)) {
					setDenied(true)
					props.onDenied()
				}
			}
		} finally {
			if (!request.signal.aborted) setBusy(false)
		}
	}
	return (
		<section
			className='bg-card min-w-0 space-y-4 rounded-xl border p-4 sm:p-6'
			aria-label={t(prefix + 'factorPreviewTitle')}
		>
			<h2 className='text-lg font-semibold'>
				{t(prefix + 'factorPreviewTitle')}
			</h2>
			<p className='text-muted-foreground text-sm'>
				{t(prefix + 'factorPreviewHint')}
			</p>
			{props.dirty && (
				<p role='status' className='text-sm'>
					{t(prefix + 'factorDraft')}
				</p>
			)}
			<FieldGroup className='grid gap-3 sm:grid-cols-3'>
				<Field>
					<FieldLabel htmlFor={id + '-model'}>
						{t(prefix + 'factorPreviewModel')}
					</FieldLabel>
					<Input
						id={id + '-model'}
						value={filters.model}
						onChange={(e) => change({ model: e.target.value })}
					/>
				</Field>
				<Field>
					<FieldLabel htmlFor={id + '-groups'}>
						{t(prefix + 'factorPreviewGroups')}
					</FieldLabel>
					<Input
						id={id + '-groups'}
						value={filters.routeGroups}
						onChange={(e) => change({ routeGroups: e.target.value })}
					/>
				</Field>
				<Field>
					<FieldLabel htmlFor={id + '-kind'}>
						{t(prefix + 'factorPreviewKind')}
					</FieldLabel>
					<NativeSelect
						id={id + '-kind'}
						value={filters.kind}
						onChange={(e) =>
							change({
								kind: e.target.value as UserModelPreviewFilters['kind'],
							})
						}
					>
						{['llm', 'image', 'audio', 'all'].map((kind) => (
							<NativeSelectOption key={kind} value={kind}>
								{kind}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</Field>
			</FieldGroup>
			<Button
				disabled={busy || denied || props.blocked}
				onClick={() => void load()}
			>
				{t(prefix + (busy ? 'loading' : 'factorPreviewRequest'))}
			</Button>
			{(error != null || props.blocked) && (
				<Alert>
					<AlertDescription>
						{t(
							prefix +
								(denied || props.blocked
									? 'factorPreviewDenied'
									: 'factorPreviewFailed')
						)}
					</AlertDescription>
				</Alert>
			)}
			{data && !props.blocked && !denied && (
				<>
					<p role='status'>
						{t(prefix + 'factorPreviewMode', {
							mode: t(
								prefix +
									(data.preview.user_charged_factor_mode === 'min'
										? 'factorPreviewMin'
										: 'factorPreviewMultiply')
							),
						})}
					</p>
					{data.preview.truncated && (
						<p role='status'>
							{t(prefix + 'factorPreviewTruncated', {
								limit: data.preview.limit,
							})}
						</p>
					)}
					{data.data.length === 0 && <p>{t(prefix + 'factorPreviewEmpty')}</p>}
					<div className='flex min-w-0 flex-col gap-3'>
						{data.data.map((model) => (
							<article
								key={model.id}
								className='min-w-0 space-y-3 rounded-lg border p-3'
							>
								<h3 className='font-semibold break-all'>
									{model.model_info.display_name ?? model.id}
								</h3>
								<p className='text-muted-foreground font-mono text-xs break-all'>
									{model.id}
								</p>
								<div className='min-w-0 overflow-x-auto'>
									<table className='w-full text-left text-xs'>
										<thead>
											<tr>
												{[
													'factorGroup',
													'factorPreviewCatalog',
													'factorPreviewRoute',
													'factorPreviewComposite',
												].map((key) => (
													<th key={key} className='p-2'>
														{t(prefix + key)}
													</th>
												))}
											</tr>
										</thead>
										<tbody>
											{Object.entries(model.model_info.discounts).map(
												([group, discount]) => (
													<tr key={group}>
														<th className='p-2 break-all'>{group}</th>
														{[
															discount.current.catalog_factor,
															discount.current.route_factor,
															discount.current.composite_factor,
														].map((value, index) => (
															<td
																key={index}
																className='p-2 tabular-nums'
																title={String(value)}
															>
																{formatUserModelPreviewFactor(
																	value,
																	i18n.resolvedLanguage
																)}
															</td>
														))}
													</tr>
												)
											)}
										</tbody>
									</table>
								</div>
								<details>
									<summary className='cursor-pointer text-sm'>
										{t(prefix + 'factorPreviewSchedule')}
									</summary>
									<pre className='bg-muted mt-2 max-h-96 min-w-0 overflow-auto rounded-md p-3 text-xs break-all whitespace-pre-wrap'>
										{JSON.stringify(model.model_info, null, 2)}
									</pre>
								</details>
							</article>
						))}
					</div>
				</>
			)}
		</section>
	)
}
