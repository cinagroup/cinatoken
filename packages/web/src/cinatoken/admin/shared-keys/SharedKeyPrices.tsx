/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import type { AdminSharedKeyRow } from './shared-key-contracts'
import { formatSharedKeyNumber } from './shared-key-display'

const prefix = 'cinatoken.adminSharedKeys.'
const priceFields = [
	'inputPrice',
	'outputPrice',
	'cacheReadPrice',
	'cacheWritePrice',
] as const
export function SharedKeyPrices(props: { row: AdminSharedKeyRow }) {
	const { t, i18n } = useTranslation()
	const locale = i18n.resolvedLanguage ?? 'en'
	return (
		<div className='space-y-1 text-xs'>
			{priceFields.map((field) => (
				<div key={field} className='flex flex-wrap justify-between gap-x-2'>
					<span className='text-muted-foreground'>{t(prefix + field)}</span>
					<span className='tabular-nums'>
						{props.row[field] === null
							? '—'
							: formatSharedKeyNumber(props.row[field], locale)}
					</span>
				</div>
			))}
			<p className='text-muted-foreground'>{t(prefix + 'priceUnit')}</p>
		</div>
	)
}
