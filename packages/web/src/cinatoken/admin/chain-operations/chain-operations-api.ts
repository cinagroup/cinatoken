/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { CinaTokenApiError, createCinaTokenCookieTransport } from '../../api'
import { authCheckSchema } from '../../contracts'
import {
	adminWithdrawalListSchema,
	adminNftMintListSchema,
	chainProcessResponseSchema,
	chainRecordIdSchema,
	chainRejectReasonSchema,
	chainRejectResponseSchema,
	canRejectChainWithdrawal,
	type AdminWithdrawalRow,
} from './chain-operations-contracts'
import {
	ChainOperationError,
	sanitizeChainReadError,
} from './chain-operations-errors'
import {
	chainOperationsListPath,
	type ChainOperationsSearch,
} from './chain-operations-search'
import type { ChainOperationKind } from './types'

export const CHAIN_CONSOLE_SUBJECT_HEADER =
	'X-CinaToken-Expected-Console-Subject'
export type ChainRequestOptions = {
	signal?: AbortSignal
	timeoutMs?: number
	expectedConsoleSubject?: string
}
export type ChainWriteOptions = ChainRequestOptions & {
	expectedConsoleSubject: string
	/** Persist the non-secret pending marker immediately before the single POST. */
	onDispatch?: () => void
}
function onlyOptions(options: ChainRequestOptions): ChainRequestOptions {
	return { signal: options.signal, timeoutMs: options.timeoutMs }
}
function invalid(): never {
	throw new CinaTokenApiError(
		'Chain records response is invalid',
		200,
		'invalid-response'
	)
}
function expectedSubjectHeaders(options: ChainRequestOptions): HeadersInit {
	const subject = options.expectedConsoleSubject
	if (subject === undefined) return {}
	if (
		!subject ||
		subject.length > 600 ||
		subject.trim() !== subject ||
		/[\p{Cc}\p{Cf}]/u.test(subject)
	)
		throw new ChainOperationError('subject')
	return { [CHAIN_CONSOLE_SUBJECT_HEADER]: encodeURIComponent(subject) }
}
function writeFailure(
	error: unknown,
	dispatched: boolean
): ChainOperationError {
	if (error instanceof ChainOperationError) return error
	if (!dispatched) return new ChainOperationError('subject')
	if (
		error instanceof CinaTokenApiError &&
		error.code === 'http' &&
		[400, 401, 403, 404, 405, 409, 413, 422].includes(error.status)
	)
		return new ChainOperationError('rejected', error.status)
	return new ChainOperationError('unknown')
}

export function createChainOperationsApi(request: typeof fetch = fetch) {
	const { send } = createCinaTokenCookieTransport(request)
	async function verifySubject(options: ChainWriteOptions): Promise<string> {
		const subject = options.expectedConsoleSubject
		if (
			!subject ||
			subject.length > 600 ||
			subject.trim() !== subject ||
			/[\p{Cc}\p{Cf}]/u.test(subject)
		)
			throw new ChainOperationError('subject')
		try {
			options.signal?.throwIfAborted()
			const check = await send(
				'/api/auth/check',
				authCheckSchema,
				{},
				onlyOptions(options)
			)
			options.signal?.throwIfAborted()
			if (
				!check.authenticated ||
				check.verification !== 'verified' ||
				check.principalType !== 'console' ||
				check.subject !== subject
			)
				throw new ChainOperationError('subject')
			return encodeURIComponent(subject)
		} catch {
			throw new ChainOperationError('subject')
		}
	}
	return {
		verifyChainOperationSubject: verifySubject,
		async chainWithdrawalList(
			search: ChainOperationsSearch,
			options: ChainRequestOptions = {}
		) {
			try {
				options.signal?.throwIfAborted()
				const result = await send(
					chainOperationsListPath('withdrawals', search),
					adminWithdrawalListSchema,
					{ headers: expectedSubjectHeaders(options) },
					onlyOptions(options)
				)
				options.signal?.throwIfAborted()
				if (
					result.total !== result.data.length ||
					new Set(result.data.map((row) => row.id)).size !==
						result.data.length ||
					result.data.some(
						(row) => search.status !== 'all' && row.status !== search.status
					)
				)
					invalid()
				return result
			} catch (error) {
				throw sanitizeChainReadError(error)
			}
		},
		async chainNftMintList(
			search: ChainOperationsSearch,
			options: ChainRequestOptions = {}
		) {
			try {
				options.signal?.throwIfAborted()
				const result = await send(
					chainOperationsListPath('nft-mints', search),
					adminNftMintListSchema,
					{ headers: expectedSubjectHeaders(options) },
					onlyOptions(options)
				)
				options.signal?.throwIfAborted()
				if (
					result.total !== result.data.length ||
					new Set(result.data.map((row) => row.id)).size !==
						result.data.length ||
					result.data.some(
						(row) => search.status !== 'all' && row.status !== search.status
					)
				)
					invalid()
				return result
			} catch (error) {
				throw sanitizeChainReadError(error)
			}
		},
		async processChainOperations(
			kind: ChainOperationKind,
			limit: number,
			options: ChainWriteOptions
		) {
			if (
				!['withdrawals', 'nft-mints'].includes(kind) ||
				!Number.isSafeInteger(limit) ||
				limit < 1 ||
				limit > 20
			)
				throw new ChainOperationError('input')
			let dispatched = false
			try {
				const subject = await verifySubject(options)
				options.signal?.throwIfAborted()
				options.onDispatch?.()
				dispatched = true
				const result = await send(
					'/api/admin/' + kind + '/process?limit=' + limit,
					chainProcessResponseSchema,
					{
						method: 'POST',
						headers: { [CHAIN_CONSOLE_SUBJECT_HEADER]: subject },
					},
					onlyOptions(options)
				)
				options.signal?.throwIfAborted()
				if (result.data.queued > limit) invalid()
				return result.data
			} catch (error) {
				throw writeFailure(error, dispatched)
			}
		},
		async rejectChainWithdrawal(
			row: AdminWithdrawalRow,
			reason: string,
			options: ChainWriteOptions
		) {
			const checked = chainRejectReasonSchema.safeParse(reason)
			if (
				!checked.success ||
				!chainRecordIdSchema.safeParse(row.id).success ||
				!canRejectChainWithdrawal(row)
			)
				throw new ChainOperationError('input')
			let dispatched = false
			try {
				const subject = await verifySubject(options)
				options.signal?.throwIfAborted()
				options.onDispatch?.()
				dispatched = true
				const result = await send(
					'/api/admin/withdrawals/' + encodeURIComponent(row.id) + '/reject',
					chainRejectResponseSchema,
					{
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							[CHAIN_CONSOLE_SUBJECT_HEADER]: subject,
						},
						body: JSON.stringify({ reason: checked.data }),
					},
					onlyOptions(options)
				)
				options.signal?.throwIfAborted()
				if (result.data.withdrawalId !== row.id) invalid()
				return result.data
			} catch (error) {
				throw writeFailure(error, dispatched)
			}
		},
	}
}
export const chainOperationsApi = createChainOperationsApi()
export type ChainOperationsApi = ReturnType<typeof createChainOperationsApi>
