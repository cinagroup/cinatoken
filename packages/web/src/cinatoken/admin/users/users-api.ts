/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { z } from 'zod'
import {
	adminUserCreatedResponseSchema,
	adminUserListResponseSchema,
	usersCurrencyResponseSchema,
	type AdminUserListResponse,
} from './users-contracts'
import { normalizeUserCreate, type UserCreateDraft } from './users-input'
import { usersListPath, type UsersSearch } from './users-search'

export type UsersRequestOptions = { signal?: AbortSignal; timeoutMs?: number }
export type UsersCurrency = {
	value: 'USD' | 'CNY'
	source: 'configured' | 'missing'
}
export type UsersTransport = {
	send<T>(
		path: string,
		schema: z.ZodType<T>,
		init: RequestInit,
		options: UsersRequestOptions
	): Promise<T>
	invalidResponse(): never
	sanitizeError(error: unknown): Error
}

export function createAdminUsersApi(transport: UsersTransport) {
	return {
		async userList(
			search: UsersSearch,
			options: UsersRequestOptions = {}
		): Promise<AdminUserListResponse> {
			try {
				options.signal?.throwIfAborted()
				const result = await transport.send(
					usersListPath(search),
					adminUserListResponseSchema,
					{},
					{ signal: options.signal, timeoutMs: options.timeoutMs }
				)
				options.signal?.throwIfAborted()
				if (
					result.page !== search.page ||
					result.data.length > result.total ||
					new Set(result.data.map((row) => row.id)).size !== result.data.length
				)
					transport.invalidResponse()
				return result
			} catch (error) {
				throw transport.sanitizeError(error)
			}
		},
		async userCurrency(
			options: UsersRequestOptions = {}
		): Promise<UsersCurrency | null> {
			try {
				options.signal?.throwIfAborted()
				const result = await transport.send(
					'/api/admin/config/overview',
					usersCurrencyResponseSchema,
					{},
					{ signal: options.signal, timeoutMs: options.timeoutMs }
				)
				options.signal?.throwIfAborted()
				const currency = result.data.billingCurrency
				if (currency.source === 'invalid' || currency.source === 'unsupported')
					return null
				if (currency.source === 'missing' && currency.value === 'USD')
					return { value: 'USD', source: 'missing' }
				if (
					currency.source === 'configured' &&
					(currency.value === 'USD' || currency.value === 'CNY')
				)
					return { value: currency.value, source: 'configured' }
				return null
			} catch (error) {
				throw transport.sanitizeError(error)
			}
		},
		async createUser(
			draft: UserCreateDraft,
			options: UsersRequestOptions = {}
		): Promise<string> {
			const checked = normalizeUserCreate(draft)
			try {
				options.signal?.throwIfAborted()
				const result = await transport.send(
					'/api/admin/users',
					adminUserCreatedResponseSchema,
					{
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(checked),
					},
					{ signal: options.signal, timeoutMs: options.timeoutMs }
				)
				options.signal?.throwIfAborted()
				return result.data.id
			} catch (error) {
				throw transport.sanitizeError(error)
			}
		},
	}
}
export type AdminUsersApi = ReturnType<typeof createAdminUsersApi>
