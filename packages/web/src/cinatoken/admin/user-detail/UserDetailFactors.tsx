/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type { UserDetail, UserDetailModel } from './user-detail-contracts'
import type { ChargedFactorRow } from './user-detail-domain'

const prefix = 'cinatoken.adminUserDetail.'
export function UserDetailFactors(props: {
	user: UserDetail
	models: UserDetailModel[] | null
	modelsDenied: boolean
	canWrite: boolean
	busy: boolean
	onSave: (rows: ChargedFactorRow[]) => Promise<void>
}) {
	const { t } = useTranslation()
	const [rows, setRows] = useState<ChargedFactorRow[]>(() =>
		Object.entries(props.user.charged_cost_factors ?? {}).map(
			([modelId, factor]) => ({
				modelId,
				factor: String(factor),
			})
		)
	)
	function update(index: number, patch: Partial<ChargedFactorRow>): void {
		setRows((before) =>
			before.map((row, i) => (i === index ? { ...row, ...patch } : row))
		)
	}
	return (
		<section className='bg-card space-y-4 rounded-xl border p-4 sm:p-6'>
			<h2 className='text-lg font-semibold'>{t(prefix + 'factors')}</h2>
			{props.modelsDenied && (
				<p role='status' className='text-muted-foreground text-sm'>
					{t(prefix + 'modelsDenied')}
				</p>
			)}
			{props.models && (
				<datalist id='user-detail-models'>
					{props.models.map((model) => (
						<option key={model.id} value={model.id}>
							{model.display_name ?? model.id}
						</option>
					))}
				</datalist>
			)}
			<div className='space-y-2'>
				{rows.map((row, index) => (
					<div
						key={index}
						className='grid grid-cols-[minmax(0,1fr)_6rem_auto] gap-2'
					>
						<label className='min-w-0 space-y-1 text-xs'>
							<span>{t(prefix + 'model')}</span>
							<input
								className='bg-background w-full rounded-md border px-2 py-2 font-mono'
								list='user-detail-models'
								value={row.modelId}
								onChange={(event) =>
									update(index, { modelId: event.target.value })
								}
								disabled={!props.canWrite}
							/>
						</label>
						<label className='space-y-1 text-xs'>
							<span>{t(prefix + 'factor')}</span>
							<input
								className='bg-background w-full rounded-md border px-2 py-2 tabular-nums'
								inputMode='decimal'
								value={row.factor}
								onChange={(event) =>
									update(index, { factor: event.target.value })
								}
								disabled={!props.canWrite}
							/>
						</label>
						<Button
							type='button'
							variant='outline'
							className='self-end'
							disabled={!props.canWrite}
							onClick={() =>
								setRows((before) => before.filter((_, i) => i !== index))
							}
						>
							{t(prefix + 'remove')}
						</Button>
					</div>
				))}
			</div>
			<div className='flex flex-wrap gap-2'>
				<Button
					type='button'
					variant='outline'
					disabled={!props.canWrite}
					onClick={() =>
						setRows((before) => [...before, { modelId: '', factor: '1' }])
					}
				>
					{t(prefix + 'addFactor')}
				</Button>
				<Button
					type='button'
					disabled={!props.canWrite || props.busy}
					onClick={() => void props.onSave(rows)}
				>
					{t(prefix + 'saveFactors')}
				</Button>
			</div>
		</section>
	)
}
