import { z } from 'zod'
import type { RequestOptions } from './api'
import {
	earningsQuerySchema,
	earningsResponseSchema,
	earningsSummaryResponseSchema,
	type EarningsPage,
	type EarningsQuery,
	type EarningsSummaryContext,
} from './earnings-contracts'

export type EarningsRequestOptions = RequestOptions & {
	expectedSellerUserId: string
	expectedWorkspaceId: string
}
type EarningsTransport = {
	send<T>(
		path: string,
		schema: z.ZodType<T>,
		init: RequestInit,
		options: RequestOptions
	): Promise<T>
	invalidResponse(message: string): never
	checkWorkspace(actual: string, options: RequestOptions): void
}

/** Ownership follows the signed-in seller. Workspace is a session precondition only. */
export function createEarningsApi(transport: EarningsTransport) {
	function scope(options: EarningsRequestOptions) {
		z.string().min(1).max(600).parse(options.expectedSellerUserId)
		z.string().min(1).max(600).parse(options.expectedWorkspaceId)
	}
	function owner(actual: string, options: EarningsRequestOptions) {
		if (actual !== options.expectedSellerUserId)
			transport.invalidResponse('Server returned another seller ledger')
	}
	return {
		earningsSummary: async (
			options: EarningsRequestOptions
		): Promise<EarningsSummaryContext> => {
			scope(options)
			const result = await transport.send(
				'/api/user/earnings/summary',
				earningsSummaryResponseSchema,
				{},
				options
			)
			owner(result.sellerUserId, options)
			transport.checkWorkspace(result.workspaceId, options)
			if (result.data) owner(result.data.userId, options)
			const { success: _success, ...context } = result
			return context
		},
		earnings: async (
			options: EarningsRequestOptions & EarningsQuery
		): Promise<EarningsPage> => {
			scope(options)
			const query = earningsQuerySchema.parse({
				page: options.page,
				pageSize: options.pageSize,
			})
			const result = await transport.send(
				`/api/user/earnings?${new URLSearchParams({ page: String(query.page), pageSize: String(query.pageSize) })}`,
				earningsResponseSchema,
				{},
				options
			)
			owner(result.sellerUserId, options)
			transport.checkWorkspace(result.workspaceId, options)
			if (
				result.page !== query.page ||
				result.pageSize !== query.pageSize ||
				result.data.length > query.pageSize ||
				(result.data.length > 0 &&
					result.total <
						(query.page - 1) * query.pageSize + result.data.length) ||
				new Set(result.data.map((row) => row.id)).size !== result.data.length
			)
				transport.invalidResponse(
					'Server returned an inconsistent earnings page'
				)
			result.data.forEach((row) => owner(row.sellerUserId, options))
			const { success: _success, ...page } = result
			return page
		},
	}
}
export type EarningsApi = ReturnType<typeof createEarningsApi>
