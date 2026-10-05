/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { ChainRecord } from './chain-operations-contracts'

export function chainAmount(
	value: number,
	locale: string,
	currency?: string
): string {
	return new Intl.NumberFormat(locale, {
		...(currency ? { style: 'currency' as const, currency } : {}),
		minimumFractionDigits: currency ? 2 : 0,
		maximumFractionDigits: 6,
	}).format(value)
}
export function chainTime(
	value: string | null,
	locale: string,
	empty: string
): string {
	return value ? new Date(value).toLocaleString(locale) : empty
}
export function chainRecordFieldValues(
	row: ChainRecord,
	locale: string,
	empty: string
): [string, string][] {
	const fields: [string, string][] = [
		['id', row.id],
		['user', row.userId],
		['wallet', row.walletAddress],
		['status', row.status],
		['time', chainTime(row.createdAt, locale, empty)],
		['confirmedAt', chainTime(row.confirmedAt, locale, empty)],
		['chainId', row.chainId === null ? empty : String(row.chainId)],
		['tx', row.txHash ?? empty],
		['failureReason', row.failureReason ?? empty],
	]
	if ('netAmount' in row) {
		fields.push(
			['amount', chainAmount(row.amount, locale, row.currency)],
			['fee', chainAmount(row.fee, locale, row.currency)],
			['net', chainAmount(row.netAmount, locale, row.currency)],
			[
				'tokenAmount',
				row.tokenAmount === null
					? empty
					: chainAmount(row.tokenAmount, locale) + ' CINA-C',
			],
			['currency', row.currency],
			['updatedAt', chainTime(row.updatedAt, locale, empty)]
		)
	} else {
		fields.push(
			['tier', row.tierName],
			['tokenId', String(row.badgeTokenId)],
			['valueSnapshot', chainAmount(row.valueSnapshot, locale, 'USD')]
		)
	}
	return fields
}
