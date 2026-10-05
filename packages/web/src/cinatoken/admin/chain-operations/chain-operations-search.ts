/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { ChainOperationKind } from './types'

export const withdrawalStatuses = [
	'requested',
	'processing',
	'submitted',
	'confirmed',
	'failed',
] as const
export const nftMintStatuses = [
	'pending',
	'processing',
	'submitted',
	'confirmed',
	'failed',
] as const
export type ChainOperationStatus =
	(typeof withdrawalStatuses)[number] | (typeof nftMintStatuses)[number]
export type ChainOperationsSearch = {
	status: 'all' | ChainOperationStatus
	page: number
	limit: number
	invalid: boolean
}

function integer(
	value: unknown,
	fallback: number,
	maximum: number
): number | null {
	if (value === undefined || value === '') return fallback
	if (typeof value !== 'string' && typeof value !== 'number') return null
	if (typeof value === 'string' && !/^[1-9]\d*$/u.test(value)) return null
	const number = Number(value)
	return Number.isSafeInteger(number) && number >= 1 && number <= maximum
		? number
		: null
}

/** URL state contains only an enum, a local page and a queue batch size. */
export function validateChainOperationsSearch(
	value: Record<string, unknown>,
	kind: ChainOperationKind
): ChainOperationsSearch {
	const statuses: readonly string[] =
		kind === 'withdrawals' ? withdrawalStatuses : nftMintStatuses
	const rawStatus = value.status ?? 'all'
	const status = rawStatus === '' ? 'all' : rawStatus
	const validStatus =
		typeof status === 'string' &&
		(status === 'all' || statuses.includes(status))
	const page = integer(value.page, 1, 100_000)
	const limit = integer(value.limit, 5, 20)
	const extra = Object.keys(value).some(
		(key) => !['status', 'page', 'limit', 'invalid'].includes(key)
	)
	return {
		status: validStatus ? (status as ChainOperationsSearch['status']) : 'all',
		page: page ?? 1,
		limit: limit ?? 5,
		invalid:
			extra ||
			!validStatus ||
			page === null ||
			limit === null ||
			(value.invalid !== undefined &&
				value.invalid !== false &&
				value.invalid !== 'false'),
	}
}

export function chainOperationsListPath(
	kind: ChainOperationKind,
	search: ChainOperationsSearch
): string {
	if (search.invalid || validateChainOperationsSearch(search, kind).invalid)
		throw new TypeError('Invalid chain operation filters')
	const base = '/api/admin/' + kind
	return search.status === 'all' ? base : base + '?status=' + search.status
}

export function chainOperationsLocalPage<T>(rows: readonly T[], page: number) {
	const totalPages = Math.max(1, Math.ceil(rows.length / 20))
	return {
		rows: rows.slice((page - 1) * 20, page * 20),
		totalPages,
		outOfRange: page > totalPages,
	}
}
