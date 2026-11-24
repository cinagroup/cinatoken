/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { z } from 'zod'
import {
	ADMIN_DOMAIN_SUBJECT_HEADER,
	type AdminDomainRequestOptions,
} from '../domain-transport'
import {
	rateLimitEquals,
	rateLimitWriteSchema,
} from '../gateway-keys/rate-limit'
import { createAdminReliabilityApi } from '../reliability/reliability-api'
import type { ReliabilityDisplay } from '../reliability/reliability-contracts'
import {
	type UserChargedCostFactors,
	chargedFactorsEqual,
	userChargedCostFactorsSchema,
} from '../user-charged-factors'
import {
	userDetailAuditsResponseSchema,
	userDetailDeletedSchema,
	userDetailKeyCreatedSchema,
	userDetailKeysResponseSchema,
	userDetailKeyUpdatedSchema,
	userDetailLogsResponseSchema,
	userDetailModelsResponseSchema,
	userDetailResponseSchema,
	userBudgetTransitionApplyResponseSchema,
	userBudgetTransitionPreviewResponseSchema,
	type UserDetail,
	type UserDetailKey,
	type UserDetailModel,
	type UserBudgetTransitionInput,
	type UserBudgetTransitionPreview,
} from './user-detail-contracts'
import { routeMatchesUser, userDetailPath } from './user-detail-domain'
import { createUserDetailKeyEditorApi } from './user-detail-key-api'
import { createUserFactorReadApi } from './user-factor-preview'
import { createUserWalletCreditApi } from './wallet-credit-api'

function sameWalletBalance(
	actual: number | undefined,
	expected: number | undefined
): boolean {
	if (actual === expected) return true
	if (actual === undefined || expected === undefined) return false
	// Detail subtracts rounded counters; transition snapshots also round the difference.
	// Compare the gateway's six-decimal money precision without treating binary drift as a failed write.
	return actual.toFixed(6) === expected.toFixed(6)
}

function sameBudgetSnapshot(
	actual: UserBudgetTransitionPreview['before'],
	expected: UserBudgetTransitionPreview['before']
): boolean {
	return (
		actual.budget_max === expected.budget_max &&
		actual.budget_base === expected.budget_base &&
		actual.budget_spent === expected.budget_spent &&
		actual.budget_period === expected.budget_period &&
		actual.budget_reset_at === expected.budget_reset_at &&
		actual.budget_epoch === expected.budget_epoch &&
		actual.budget_reserved_micros === expected.budget_reserved_micros &&
		actual.wallet_granted === expected.wallet_granted &&
		actual.wallet_spent === expected.wallet_spent &&
		actual.wallet_balance === expected.wallet_balance
	)
}

export type UserDetailOptions = AdminDomainRequestOptions
export type UserDetailTransport = {
	send<T>(
		path: string,
		schema: z.ZodType<T>,
		init: RequestInit,
		options: UserDetailOptions
	): Promise<T>
	invalidResponse(message?: string): never
	sanitizeError(error: unknown): Error
}

export function createAdminUserDetailApi(transport: UserDetailTransport) {
	const display = createAdminReliabilityApi(transport).display
	const factorReads = createUserFactorReadApi(transport)
	async function send<T>(
		path: string,
		schema: z.ZodType<T>,
		init: RequestInit,
		options: UserDetailOptions
	): Promise<T> {
		try {
			options.signal?.throwIfAborted()
			const result = await transport.send(path, schema, init, options)
			options.signal?.throwIfAborted()
			return result
		} catch (error) {
			throw transport.sanitizeError(error)
		}
	}
	function body(method: string, payload: Record<string, unknown>): RequestInit {
		return {
			method,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		}
	}
	return {
		...createUserDetailKeyEditorApi(transport),
		...createUserWalletCreditApi(transport),
		...factorReads,
		async saveUserFactors(
			routeId: string,
			expectedUserId: string,
			value: UserChargedCostFactors,
			reason: string,
			options: UserDetailOptions
		): Promise<UserDetail> {
			const factors = userChargedCostFactorsSchema.parse(value)
			if (!reason.trim() || reason.trim().length > 2000)
				transport.invalidResponse('Invalid reason')
			const subject = await factorReads.verifyUserFactorSubject(options)
			options.signal?.throwIfAborted()
			options.onDispatch?.('charged-factors')
			const init = body('PATCH', {
				charged_cost_factors: factors,
				reason: reason.trim(),
			})
			const result = await send(
				userDetailPath(routeId),
				userDetailResponseSchema,
				{
					...init,
					headers: {
						'Content-Type': 'application/json',
						[ADMIN_DOMAIN_SUBJECT_HEADER]: subject,
					},
				},
				options
			)
			if (
				result.data.id !== expectedUserId ||
				!chargedFactorsEqual(result.data.charged_cost_factors, factors)
			)
				transport.invalidResponse('Updated factors differ')
			return result.data
		},
		async readUserFactorState(
			id: string,
			options: UserDetailOptions
		): Promise<UserDetail> {
			const subject = await factorReads.verifyUserFactorSubject(options)
			const result = await send(
				userDetailPath(id),
				userDetailResponseSchema,
				{ headers: { [ADMIN_DOMAIN_SUBJECT_HEADER]: subject } },
				options
			)
			if (result.data.id !== id)
				transport.invalidResponse('User identity differs')
			return result.data
		},
		userDetailDisplay(
			options: UserDetailOptions = {}
		): Promise<ReliabilityDisplay> {
			return display(options)
		},
		async userDetail(
			routeId: string,
			options: UserDetailOptions = {}
		): Promise<UserDetail> {
			const result = await send(
				userDetailPath(routeId),
				userDetailResponseSchema,
				{},
				options
			)
			if (!routeMatchesUser(routeId, result.data))
				transport.invalidResponse('User route identity differs')
			return result.data
		},
		async userDetailKeys(
			routeId: string,
			userId: string,
			options: UserDetailOptions = {}
		): Promise<UserDetailKey[]> {
			const result = await send(
				`${userDetailPath(routeId)}/keys`,
				userDetailKeysResponseSchema,
				{},
				options
			)
			if (
				result.data.some((key) => key.user_id !== userId) ||
				new Set(result.data.map((key) => key.id)).size !== result.data.length
			)
				transport.invalidResponse('User key identity differs')
			return result.data
		},
		async userDetailLogs(
			routeId: string,
			userId: string,
			options: UserDetailOptions = {}
		) {
			const result = await send(
				`${userDetailPath(routeId)}/logs?page=1&page_size=5`,
				userDetailLogsResponseSchema,
				{},
				options
			)
			if (
				result.data.some((log) => log.user_id !== userId) ||
				new Set(result.data.map((log) => log.id)).size !== result.data.length
			)
				transport.invalidResponse('User log identity differs')
			return result.data
		},
		async userDetailAudits(
			routeId: string,
			userId: string,
			options: UserDetailOptions = {}
		) {
			const result = await send(
				`${userDetailPath(routeId)}/audit-logs?page=1&page_size=5`,
				userDetailAuditsResponseSchema,
				{},
				options
			)
			if (
				result.data.some((log) => log.user_id !== userId) ||
				new Set(result.data.map((log) => log.id)).size !== result.data.length
			)
				transport.invalidResponse('User audit identity differs')
			return result.data
		},
		async userDetailModels(
			options: UserDetailOptions = {}
		): Promise<UserDetailModel[]> {
			const result = await send(
				'/api/admin/models',
				userDetailModelsResponseSchema,
				{},
				options
			)
			if (
				result.data.length !== result.count ||
				new Set(result.data.map((model) => model.id)).size !==
					result.data.length
			)
				transport.invalidResponse('Model catalog differs')
			return result.data
		},
		async patchUserDetail(
			routeId: string,
			expectedUserId: string,
			patch: Record<string, unknown>,
			options: UserDetailOptions = {}
		): Promise<UserDetail> {
			const rate = rateLimitWriteSchema.optional().safeParse(patch.rate_limit)
			if (!rate.success) transport.invalidResponse()
			const expectedRate = rate.data
			const factors = userChargedCostFactorsSchema
				.optional()
				.safeParse(patch.charged_cost_factors)
			if (!factors.success) transport.invalidResponse()
			const result = await send(
				userDetailPath(routeId),
				userDetailResponseSchema,
				body('PATCH', patch),
				options
			)
			if (
				factors.data !== undefined &&
				!chargedFactorsEqual(result.data.charged_cost_factors, factors.data)
			)
				transport.invalidResponse('Updated factors differ')
			if (result.data.id !== expectedUserId)
				transport.invalidResponse('Updated user identity differs')
			if (
				expectedRate !== undefined &&
				!rateLimitEquals(result.data.rate_limit, expectedRate)
			)
				transport.invalidResponse('Updated rate limit differs')
			for (const field of ['wallet_granted', 'wallet_spent'] as const)
				if (patch[field] !== undefined && result.data[field] !== patch[field])
					transport.invalidResponse('Updated wallet differs')
			return result.data
		},
		async previewUserBudgetTransition(
			routeId: string,
			input: UserBudgetTransitionInput,
			options: UserDetailOptions = {}
		): Promise<UserBudgetTransitionPreview> {
			const result = await send(
				`${userDetailPath(routeId)}/budget/transition/preview`,
				userBudgetTransitionPreviewResponseSchema,
				body('POST', input),
				options
			)
			return result.data
		},
		async applyUserBudgetTransition(
			routeId: string,
			expectedUserId: string,
			input: UserBudgetTransitionInput,
			preview: UserBudgetTransitionPreview,
			options: UserDetailOptions = {}
		): Promise<UserDetail> {
			const result = await send(
				`${userDetailPath(routeId)}/budget/transition`,
				userBudgetTransitionApplyResponseSchema,
				body('POST', {
					...input,
					budget_reset_at: preview.after.budget_reset_at,
					expected_before: preview.before,
				}),
				options
			)
			if (result.data.user.id !== expectedUserId)
				transport.invalidResponse('Transition user identity differs')
			if (!sameBudgetSnapshot(result.data.transition.before, preview.before))
				transport.invalidResponse('Transition preview differs')
			if (
				!sameBudgetSnapshot(result.data.transition.after, preview.after) ||
				result.data.transition.carryover !== preview.carryover
			)
				transport.invalidResponse('Reviewed transition result differs')
			const after = result.data.transition.after
			const updated = result.data.user
			if (
				updated.budget_max !== after.budget_max ||
				updated.budget_base !== after.budget_base ||
				updated.budget_spent !== after.budget_spent ||
				updated.budget_period !== after.budget_period ||
				updated.budget_reset_at !== after.budget_reset_at ||
				updated.wallet_granted !== after.wallet_granted ||
				updated.wallet_spent !== after.wallet_spent ||
				!sameWalletBalance(updated.wallet_balance, after.wallet_balance)
			)
				transport.invalidResponse('Transition applied user differs')
			return result.data.user
		},
		async deleteUserDetail(
			routeId: string,
			options: UserDetailOptions = {}
		): Promise<void> {
			await send(
				userDetailPath(routeId),
				userDetailDeletedSchema,
				{ method: 'DELETE' },
				options
			)
		},
		async createUserDetailKey(
			routeId: string,
			name: string | null,
			metadata: string | null,
			onSecret: (secret: string) => void,
			options: UserDetailOptions = {}
		): Promise<{ keyId: string }> {
			const result = await send(
				`${userDetailPath(routeId)}/keys`,
				userDetailKeyCreatedSchema,
				body('POST', { name, metadata, reason: 'gwui:user-detail' }),
				options
			)
			onSecret(result.data.key)
			return { keyId: result.data.key_id }
		},
		async patchUserDetailKey(
			routeId: string,
			keyId: string,
			status: 'active' | 'revoked',
			options: UserDetailOptions = {}
		): Promise<void> {
			const result = await send(
				`${userDetailPath(routeId)}/keys/${encodeURIComponent(keyId)}`,
				userDetailKeyUpdatedSchema,
				body('PATCH', { status, reason: `gwui:st:${status}` }),
				options
			)
			if (result.data.id !== keyId)
				transport.invalidResponse('Updated key identity differs')
		},
		async deleteUserDetailKey(
			routeId: string,
			keyId: string,
			options: UserDetailOptions = {}
		): Promise<void> {
			await send(
				`${userDetailPath(routeId)}/keys/${encodeURIComponent(keyId)}`,
				userDetailDeletedSchema,
				{ method: 'DELETE' },
				options
			)
		},
	}
}
export type AdminUserDetailApi = ReturnType<typeof createAdminUserDetailApi>
