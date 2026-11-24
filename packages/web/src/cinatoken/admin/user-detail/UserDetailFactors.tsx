/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import {
	Field,
	FieldGroup,
	FieldLabel,
	FieldDescription,
} from '../../../components/ui/field'
import { Input } from '../../../components/ui/input'
import type { AdminDomainRequestOptions } from '../domain-transport'
import {
	chargedFactorRows,
	chargedFactorsEqual,
	normalizeChargedFactorRows,
	type ChargedFactorRow,
} from '../user-charged-factors'
import { UserModelsPricePreview } from './UserModelsPricePreview'
import type { AdminUserDetailApi } from './user-detail-api'
import type { UserDetail, UserDetailModel } from './user-detail-contracts'

const prefix = 'cinatoken.adminUserDetail.'
export function UserDetailFactors(props: {
	user: UserDetail
	models: UserDetailModel[] | null
	modelsDenied: boolean
	canWrite: boolean
	busy: boolean
	api: AdminUserDetailApi
	options: AdminDomainRequestOptions
	previewDenied: boolean
	onPreviewDenied: () => void
	onSave: (rows: ChargedFactorRow[], reason: string) => Promise<void>
}) {
	const { t } = useTranslation(),
		id = useId(),
		controller = useRef<AbortController | null>(null)
	const [rows, setRows] = useState(() =>
			chargedFactorRows(props.user.charged_cost_factors)
		),
		[reason, setReason] = useState(''),
		[groups, setGroups] = useState<Map<string, string[]>>(() => new Map()),
		[groupError, setGroupError] = useState(false),
		[groupBusy, setGroupBusy] = useState(false)
	useEffect(() => () => controller.current?.abort(), [])
	let dirty = true
	try {
		dirty = !chargedFactorsEqual(
			normalizeChargedFactorRows(rows),
			props.user.charged_cost_factors
		)
	} catch {
		/* Invalid drafts remain visibly unsaved. */
	}
	function update(index: number, patch: Partial<ChargedFactorRow>) {
		setRows((previous) =>
			previous.map((row, i) => (i === index ? { ...row, ...patch } : row))
		)
	}
	async function loadGroups() {
		if (groupBusy) return
		const request = new AbortController()
		controller.current?.abort()
		controller.current = request
		setGroupBusy(true)
		setGroupError(false)
		try {
			const next = await props.api.userFactorGroups({
				...props.options,
				signal: request.signal,
			})
			if (!request.signal.aborted) setGroups(next)
		} catch {
			if (!request.signal.aborted) setGroupError(true)
		} finally {
			if (!request.signal.aborted) setGroupBusy(false)
		}
	}
	return (
		<>
			<section
				className='bg-card min-w-0 space-y-4 rounded-xl border p-4 sm:p-6'
				aria-label={t(prefix + 'factors')}
			>
				<h2 className='text-lg font-semibold'>{t(prefix + 'factors')}</h2>
				<p className='text-muted-foreground text-sm'>
					{t(prefix + 'factorHint')}
				</p>
				{props.modelsDenied && (
					<p role='status' className='text-muted-foreground text-sm'>
						{t(prefix + 'modelsDenied')}
					</p>
				)}
				{props.models && (
					<datalist id={id + '-models'}>
						{props.models.map((model) => (
							<option key={model.id} value={model.id}>
								{model.display_name ?? model.id}
							</option>
						))}
					</datalist>
				)}
				<Button
					variant='outline'
					disabled={groupBusy}
					onClick={() => void loadGroups()}
				>
					{t(prefix + (groupBusy ? 'loading' : 'factorGroupsLoad'))}
				</Button>
				{groupError && (
					<p role='status' className='text-sm'>
						{t(prefix + 'factorGroupsUnavailable')}
					</p>
				)}
				<fieldset
					disabled={!props.canWrite || props.busy}
					className='min-w-0 space-y-3'
				>
					{rows.map((row, index) => (
						<FieldGroup
							key={index}
							className='grid min-w-0 items-end gap-3 rounded-lg border p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_7rem_auto]'
						>
							<Field>
								<FieldLabel htmlFor={id + '-model-' + index}>
									{t(prefix + 'model')}
								</FieldLabel>
								<Input
									id={id + '-model-' + index}
									list={id + '-models'}
									value={row.modelId}
									onChange={(event) =>
										update(index, { modelId: event.target.value })
									}
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor={id + '-group-' + index}>
									{t(prefix + 'factorGroup')}
								</FieldLabel>
								<Input
									id={id + '-group-' + index}
									list={id + '-groups-' + index}
									value={row.routeGroup ?? '*'}
									onChange={(event) =>
										update(index, { routeGroup: event.target.value })
									}
								/>
								<FieldDescription>
									{t(prefix + 'factorAllGroups')}
								</FieldDescription>
								<datalist id={id + '-groups-' + index}>
									<option value='*' />
									{(groups.get(row.modelId) ?? []).map((group) => (
										<option key={group} value={group} />
									))}
								</datalist>
							</Field>
							<Field>
								<FieldLabel htmlFor={id + '-factor-' + index}>
									{t(prefix + 'factor')}
								</FieldLabel>
								<Input
									id={id + '-factor-' + index}
									inputMode='decimal'
									value={row.factor}
									onChange={(event) =>
										update(index, { factor: event.target.value })
									}
								/>
							</Field>
							<Button
								variant='outline'
								onClick={() =>
									setRows((previous) => previous.filter((_, i) => i !== index))
								}
							>
								{t(prefix + 'remove')}
							</Button>
						</FieldGroup>
					))}
					<Button
						variant='outline'
						onClick={() =>
							setRows((previous) => [
								...previous,
								{ modelId: '', routeGroup: '*', factor: '1' },
							])
						}
					>
						{t(prefix + 'addFactor')}
					</Button>
					<Field>
						<FieldLabel htmlFor={id + '-reason'}>
							{t(prefix + 'factorReason')}
						</FieldLabel>
						<Input
							id={id + '-reason'}
							value={reason}
							onChange={(e) => setReason(e.target.value)}
							maxLength={2000}
						/>
					</Field>
					<div className='flex flex-wrap gap-2'>
						<Button
							disabled={!dirty || !reason.trim()}
							onClick={() => void props.onSave(rows, reason)}
						>
							{t(prefix + 'saveFactors')}
						</Button>
						<Button
							variant='outline'
							disabled={!dirty}
							onClick={() => {
								setRows(chargedFactorRows(props.user.charged_cost_factors))
								setReason('')
							}}
						>
							{t(prefix + 'factorDiscard')}
						</Button>
					</div>
				</fieldset>
			</section>
			<UserModelsPricePreview
				api={props.api}
				userId={props.user.id}
				options={props.options}
				dirty={dirty}
				blocked={props.previewDenied}
				onDenied={props.onPreviewDenied}
			/>
		</>
	)
}
