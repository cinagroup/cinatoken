/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { requestLogTargetHref } from '../request-logs/request-log-target'
import type { AdminEarningReviewResult } from './review-contracts'

const prefix = 'cinatoken.adminSharedKeys.'
export function EarningReviewResult(props: {
	result: AdminEarningReviewResult
	canReadLogs: boolean
}) {
	const { t } = useTranslation()
	const active = useRef(true)
	const [copied, setCopied] = useState<string | null>(null)
	useEffect(() => {
		active.current = true
		return () => {
			active.current = false
		}
	}, [])
	const data = props.result.data
	let message = 'reviewDiscovery'
	if (!props.result.success)
		message =
			props.result.code === 'historical_earning_evidence_required'
				? 'reviewEvidence'
				: 'reviewIncomplete'
	else if (!props.result.dryRun) message = 'reviewNoCandidates'
	return (
		<div className='space-y-3 rounded-lg border p-4'>
			<p role='status' className='text-sm'>
				{t(prefix + message)}
			</p>
			<p className='text-muted-foreground text-xs'>
				{t(prefix + 'since')}:{' '}
				<time dateTime={data.windowSince}>{data.windowSince}</time> ·{' '}
				{t(prefix + 'limit')}: {data.range.limit}
			</p>
			<dl className='grid grid-cols-2 gap-3 text-sm sm:grid-cols-4'>
				{(
					['scanned', 'windowTotal', 'candidates', 'reviewRequired'] as const
				).map((field) => (
					<div key={field}>
						<dt className='text-muted-foreground text-xs'>
							{t(prefix + field)}
						</dt>
						<dd className='mt-1 tabular-nums'>{data[field]}</dd>
					</div>
				))}
			</dl>
			<p className='text-sm'>
				{t(prefix + (data.scanComplete ? 'scanComplete' : 'scanIncomplete'))}
			</p>
			{data.candidateLogIds.length > 0 ? (
				<ul className='max-h-64 space-y-2 overflow-y-auto'>
					{data.candidateLogIds.map((id) => (
						<li key={id} className='flex flex-wrap items-center gap-2'>
							<code className='text-xs break-all'>{id}</code>
							{props.canReadLogs && (
								<a
									className='text-primary text-sm underline underline-offset-4'
									href={requestLogTargetHref(id)}
								>
									{t(prefix + 'openLog')}
								</a>
							)}
							<Button
								type='button'
								size='sm'
								variant='outline'
								onClick={() => {
									void navigator.clipboard
										.writeText(id)
										.then(() => {
											if (active.current) setCopied('copied')
										})
										.catch(() => {
											if (active.current) setCopied('copyFailed')
										})
								}}
							>
								{t(prefix + 'copyLogId')}
							</Button>
						</li>
					))}
				</ul>
			) : (
				<p className='text-muted-foreground text-xs'>{t(prefix + 'noLogs')}</p>
			)}
			{copied && (
				<p role='status' className='text-xs'>
					{t(prefix + copied)}
				</p>
			)}
		</div>
	)
}
