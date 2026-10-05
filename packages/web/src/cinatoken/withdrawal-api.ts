import { z } from 'zod'
import type { RequestOptions } from './api'
import {
	createdWithdrawalResponseSchema,
	createWithdrawalInputSchema,
	quoteWithdrawalInputSchema,
	withdrawalPageResponseSchema,
	withdrawalQuerySchema,
	withdrawalQuoteResponseSchema,
	type CreateWithdrawalInput,
	type QuoteWithdrawalInput,
	type Withdrawal,
	type WithdrawalPage,
	type WithdrawalQuery,
	type WithdrawalQuoteContext,
} from './withdrawal-contracts'

export type WithdrawalRequestOptions = RequestOptions & {
	expectedUserId: string
	expectedWorkspaceId: string
}
type WithdrawalTransport = {
	send<T>(
		path: string,
		schema: z.ZodType<T>,
		init: RequestInit,
		options: RequestOptions
	): Promise<T>
	checkWorkspace(actual: string, options: RequestOptions): void
	invalidResponse(message: string): never
}
export function createWithdrawalsApi(transport: WithdrawalTransport) {
	function scope(options: WithdrawalRequestOptions) {
		z.string().trim().min(1).max(600).parse(options.expectedUserId)
		z.string().trim().min(1).max(600).parse(options.expectedWorkspaceId)
	}
	function check(
		result: {
			userId: string
			workspaceId: string
			activeWithdrawal: Withdrawal | null
		},
		options: WithdrawalRequestOptions
	) {
		transport.checkWorkspace(result.workspaceId, options)
		if (
			result.userId !== options.expectedUserId ||
			(result.activeWithdrawal &&
				result.activeWithdrawal.userId !== options.expectedUserId)
		)
			transport.invalidResponse('Server returned another withdrawal owner')
	}
	function body(input: unknown): RequestInit {
		return {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(input),
		}
	}
	function sameAmount(a: number, b: number) {
		return Math.abs(a - b) < 1e-9
	}
	return {
		withdrawals: async (
			options: WithdrawalRequestOptions & WithdrawalQuery
		): Promise<WithdrawalPage> => {
			scope(options)
			const query = withdrawalQuerySchema.parse({
				page: options.page,
				pageSize: options.pageSize,
			})
			const result = await transport.send(
				`/api/user/withdrawals?${new URLSearchParams({ page: String(query.page), pageSize: String(query.pageSize) })}`,
				withdrawalPageResponseSchema,
				{},
				options
			)
			check(result, options)
			if (
				result.page !== query.page ||
				result.pageSize !== query.pageSize ||
				result.data.length > query.pageSize ||
				new Set(result.data.map((row) => row.id)).size !== result.data.length ||
				result.data.some((row) => row.userId !== options.expectedUserId) ||
				(result.data.length > 0 &&
					result.total < (query.page - 1) * query.pageSize + result.data.length)
			)
				transport.invalidResponse(
					'Server returned inconsistent withdrawal pagination'
				)
			const { success: _success, ...page } = result
			return page
		},
		quoteWithdrawal: async (
			input: QuoteWithdrawalInput,
			options: WithdrawalRequestOptions
		): Promise<WithdrawalQuoteContext> => {
			scope(options)
			const parsed = quoteWithdrawalInputSchema.parse(input)
			const result = await transport.send(
				'/api/user/withdrawals/quote',
				withdrawalQuoteResponseSchema,
				body(parsed),
				options
			)
			check(result, options)
			if (
				result.data.amount !== parsed.amount ||
				parsed.amount < result.policy.minAmount ||
				result.dailyRemaining <= 0 ||
				result.dailyRemaining > result.policy.dailyLimit ||
				!result.queueConfigured ||
				result.chainId === null ||
				!sameAmount(result.data.fee, result.policy.fee) ||
				!sameAmount(
					result.data.netAmount,
					Math.round((parsed.amount - result.data.fee) * 1000000) / 1000000
				) ||
				!sameAmount(
					result.data.tokenAmount,
					Math.round(
						result.data.netAmount * result.policy.tokenRate * 1000000
					) / 1000000
				) ||
				result.availability !== 'available' ||
				result.walletAddress === null ||
				result.activeWithdrawal !== null ||
				result.balance === null ||
				result.balance < parsed.amount ||
				result.data.tokenAmount <= 0
			)
				transport.invalidResponse(
					'Server returned an inconsistent withdrawal quote'
				)
			const { success: _success, ...quote } = result
			return quote
		},
		createWithdrawal: async (
			input: CreateWithdrawalInput,
			options: WithdrawalRequestOptions
		): Promise<Withdrawal> => {
			scope(options)
			const parsed = createWithdrawalInputSchema.parse(input)
			const result = await transport.send(
				'/api/user/withdrawals',
				createdWithdrawalResponseSchema,
				body(parsed),
				options
			)
			check(result, options)
			if (
				result.data.userId !== options.expectedUserId ||
				result.data.amount !== parsed.amount ||
				result.data.walletAddress !== result.walletAddress
			)
				transport.invalidResponse('Server returned an inconsistent withdrawal')
			return result.data
		},
	}
}
export type WithdrawalsApi = ReturnType<typeof createWithdrawalsApi>
