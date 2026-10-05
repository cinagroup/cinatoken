/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { SharedKeyPrices } from './SharedKeyPrices'
import type { AdminSharedKeyRow } from './shared-key-contracts'
import {
	formatSharedKeyEarnings,
	formatSharedKeyNumber,
	formatSharedKeyTime,
} from './shared-key-display'

const prefix = 'cinatoken.adminSharedKeys.'
const dateFields = [
	'createdAt',
	'updatedAt',
	'validatedAt',
	'lastUsedAt',
	'lastFailureAt',
] as const
export function SharedKeyProfile(props: {
	row: AdminSharedKeyRow
	canReadUser: boolean
}) {
	const { t, i18n } = useTranslation()
	const locale = i18n.resolvedLanguage ?? 'en'
	const active = useRef(true)
	const [copied, setCopied] = useState<string | null>(null)
	useEffect(() => {
		active.current = true
		return () => {
			active.current = false
		}
	}, [])
	return (
		<section className='space-y-4'>
			<dl className='grid gap-3 text-sm sm:grid-cols-2'>
				<div>
					<dt className='text-muted-foreground'>{t(prefix + 'keyId')}</dt>
					<dd className='font-mono text-xs break-all'>{props.row.id}</dd>
					<Button
						type='button'
						size='sm'
						variant='outline'
						className='mt-1'
						onClick={() => {
							void navigator.clipboard
								.writeText(props.row.id)
								.then(() => {
									if (active.current) setCopied('copied')
								})
								.catch(() => {
									if (active.current) setCopied('copyFailed')
								})
						}}
					>
						{t(prefix + 'copyId')}
					</Button>
					{copied && (
						<p role='status' className='mt-1 text-xs'>
							{t(prefix + copied)}
						</p>
					)}
				</div>
				<div>
					<dt className='text-muted-foreground'>{t(prefix + 'seller')}</dt>
					<dd className='break-all'>
						{props.row.sellerEmail ?? props.row.sellerUserId}
					</dd>
					<dd className='font-mono text-xs break-all'>
						{props.row.sellerUserId}
					</dd>
					{props.canReadUser && (
						<a
							className='text-primary text-xs underline'
							href={
								'/admin/users/' + encodeURIComponent(props.row.sellerUserId)
							}
						>
							{t(prefix + 'userDetail')}
						</a>
					)}
				</div>
				<div>
					<dt className='text-muted-foreground'>{t(prefix + 'label')}</dt>
					<dd className='break-all'>
						{props.row.label ?? t(prefix + 'unnamed')}
					</dd>
				</div>
				<div>
					<dt className='text-muted-foreground'>{t(prefix + 'maskedKey')}</dt>
					<dd className='font-mono'>{props.row.apiKeyMasked}</dd>
				</div>
				<div>
					<dt className='text-muted-foreground'>{t(prefix + 'channel')}</dt>
					<dd>{props.row.channelType}</dd>
				</div>
				<div>
					<dt className='text-muted-foreground'>{t(prefix + 'status')}</dt>
					<dd>{t(prefix + 'status_' + props.row.status)}</dd>
					{props.row.failureCode !== null && (
						<dd className='text-destructive text-xs'>
							{t(prefix + 'failure')}:{' '}
							{t(prefix + 'failure_' + props.row.failureCode)}
						</dd>
					)}
				</div>
				<div>
					<dt className='text-muted-foreground'>{t(prefix + 'priority')}</dt>
					<dd>{props.row.sellerPriority}</dd>
				</div>
				<div>
					<dt className='text-muted-foreground'>{t(prefix + 'weight')}</dt>
					<dd>{props.row.weight}</dd>
				</div>
				<div>
					<dt className='text-muted-foreground'>{t(prefix + 'inputTokens')}</dt>
					<dd>{formatSharedKeyNumber(props.row.servedInputTokens, locale)}</dd>
				</div>
				<div>
					<dt className='text-muted-foreground'>
						{t(prefix + 'outputTokens')}
					</dt>
					<dd>{formatSharedKeyNumber(props.row.servedOutputTokens, locale)}</dd>
				</div>
				<div>
					<dt className='text-muted-foreground'>{t(prefix + 'earned')}</dt>
					<dd>{formatSharedKeyEarnings(props.row.earnedTotal, locale)}</dd>
				</div>
				{dateFields.map((field) => (
					<div key={field}>
						<dt className='text-muted-foreground'>{t(prefix + field)}</dt>
						<dd>{formatSharedKeyTime(props.row[field], locale)}</dd>
					</div>
				))}
			</dl>
			<p className='text-muted-foreground text-xs'>
				{t(prefix + 'statistics_' + props.row.statisticsBasis)}
			</p>
			<div className='bg-muted/30 rounded-lg border p-3'>
				<h3 className='mb-2 text-sm font-medium'>{t(prefix + 'pricing')}</h3>
				<SharedKeyPrices row={props.row} />
				<p className='text-muted-foreground mt-2 text-xs'>
					{t(prefix + 'legacyPrice')}
				</p>
			</div>
		</section>
	)
}
