/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import { CinaTokenApiError, createCinaTokenCookieTransport } from '../../api'
import type { UsersRequestOptions } from '../users/users-api'
import { createAdminSharedKeyAuditApi } from './audit-api'
import { createAdminEarningReviewApi } from './review-api'
import {
	adminSharedKeyConflictSchema,
	adminSharedKeyDeleteResponseSchema,
	adminSharedKeyDetailSchema,
	adminSharedKeyIdSchema,
	adminSharedKeyOverviewSchema,
	adminSharedKeyPatchResponseSchema,
	type AdminSharedKeyConflictCode,
	type AdminSharedKeyRow,
} from './shared-key-contracts'
import {
	AdminSharedKeyInputError,
	sanitizeSharedKeyError,
} from './shared-key-errors'
import {
	adminSharedKeyDeleteSchema,
	adminSharedKeyPatchSchema,
	type AdminSharedKeyPatch,
} from './shared-key-input'
import {
	adminSharedKeyListPath,
	type AdminSharedKeySearch,
} from './shared-key-search'
import {
	createAdminSharedKeySubjectGate,
	SHARED_KEY_CONSOLE_SUBJECT_HEADER,
	type AdminSharedKeyBoundOptions,
} from './shared-key-subject'

export class AdminSharedKeyConflictError extends CinaTokenApiError {
	constructor(readonly conflict: AdminSharedKeyConflictCode) {
		super('Shared key operation was rejected', 409, 'http')
	}
}
function invalid(): never {
	throw new CinaTokenApiError(
		'Shared key response is invalid',
		200,
		'invalid-response'
	)
}
function json(
	method: 'PATCH' | 'DELETE',
	body: object,
	subject: string
): RequestInit {
	return {
		method,
		headers: {
			'Content-Type': 'application/json',
			[SHARED_KEY_CONSOLE_SUBJECT_HEADER]: subject,
		},
		body: JSON.stringify(body),
	}
}
function keyPath(id: string): string {
	if (!adminSharedKeyIdSchema.safeParse(id).success)
		throw new AdminSharedKeyInputError()
	return '/api/admin/shared-keys/' + encodeURIComponent(id)
}
function conflictResponse(response: Response, body: unknown): boolean {
	return (
		response.status === 409 &&
		adminSharedKeyConflictSchema.safeParse(body).success
	)
}
function optionsOnly(options: UsersRequestOptions): UsersRequestOptions {
	return { signal: options.signal, timeoutMs: options.timeoutMs }
}
export function createAdminSharedKeysApi(request: typeof fetch = fetch) {
	const { send } = createCinaTokenCookieTransport(request)
	const verifySubject = createAdminSharedKeySubjectGate(request)
	return {
		...createAdminEarningReviewApi(request),
		...createAdminSharedKeyAuditApi(request),
		verifyAdminSharedKeyRecoverySubject: verifySubject,
		async adminSharedKeyRecoveryDetail(
			id: string,
			options: UsersRequestOptions = {}
		) {
			try {
				const result = await send(
					keyPath(id) + '/detail',
					adminSharedKeyDetailSchema,
					{},
					optionsOnly(options)
				)
				if (result.data.id !== id) invalid()
				return result.data
			} catch (error) {
				if (
					error instanceof CinaTokenApiError &&
					error.status === 404 &&
					error.code === 'http'
				)
					return null
				throw sanitizeSharedKeyError(error)
			}
		},
		async adminSharedKeyList(
			search: AdminSharedKeySearch,
			options: UsersRequestOptions = {}
		) {
			try {
				const result = await send(
					adminSharedKeyListPath(search),
					adminSharedKeyOverviewSchema,
					{},
					optionsOnly(options)
				)
				const page = result.data
				if (
					page.page !== search.page ||
					page.page_size !== 20 ||
					page.items.length > 20 ||
					new Set(page.items.map((row) => row.id)).size !== page.items.length ||
					page.hasMore !== page.page * 20 < page.total ||
					page.items.some(
						(row) =>
							(search.status && row.status !== search.status) ||
							(search.channelType && row.channelType !== search.channelType) ||
							(search.seller_user_id &&
								row.sellerUserId !== search.seller_user_id)
					)
				)
					invalid()
				return page
			} catch (error) {
				throw sanitizeSharedKeyError(error)
			}
		},
		async adminSharedKeyDetail(
			expected: AdminSharedKeyRow,
			options: UsersRequestOptions = {}
		) {
			try {
				const result = await send(
					keyPath(expected.id) + '/detail',
					adminSharedKeyDetailSchema,
					{},
					optionsOnly(options)
				)
				if (
					result.data.id !== expected.id ||
					result.data.sellerUserId !== expected.sellerUserId ||
					result.data.channelType !== expected.channelType
				)
					invalid()
				return result.data
			} catch (error) {
				throw sanitizeSharedKeyError(error)
			}
		},
		async patchAdminSharedKey(
			expected: AdminSharedKeyRow,
			input: AdminSharedKeyPatch,
			options: AdminSharedKeyBoundOptions = { expectedConsoleSubject: '' }
		) {
			const checked = adminSharedKeyPatchSchema.safeParse(input)
			if (
				!checked.success ||
				checked.data.expected_revision !== expected.profile_revision ||
				(checked.data.status === 'paused' && expected.status !== 'disabled')
			)
				throw new AdminSharedKeyInputError()
			try {
				const subject = await verifySubject(options)
				const result = await send(
					keyPath(expected.id),
					z.union([
						adminSharedKeyPatchResponseSchema,
						adminSharedKeyConflictSchema,
					]),
					json('PATCH', checked.data, subject),
					optionsOnly(options),
					undefined,
					conflictResponse
				)
				if (!result.success) throw new AdminSharedKeyConflictError(result.code)
				if (result.data.id !== expected.id) invalid()
				return result.data
			} catch (error) {
				if (error instanceof AdminSharedKeyConflictError) throw error
				throw sanitizeSharedKeyError(error)
			}
		},
		async deleteAdminSharedKey(
			expected: AdminSharedKeyRow,
			reason: string,
			options: AdminSharedKeyBoundOptions = { expectedConsoleSubject: '' }
		) {
			const checked = adminSharedKeyDeleteSchema.safeParse({
				expected_revision: expected.profile_revision,
				reason,
			})
			if (!checked.success) throw new AdminSharedKeyInputError()
			try {
				const subject = await verifySubject(options)
				const result = await send(
					keyPath(expected.id),
					z.union([
						adminSharedKeyDeleteResponseSchema,
						adminSharedKeyConflictSchema,
					]),
					json('DELETE', checked.data, subject),
					optionsOnly(options),
					undefined,
					conflictResponse
				)
				if (!result.success) throw new AdminSharedKeyConflictError(result.code)
				if (result.data.id !== expected.id) invalid()
				return result.data
			} catch (error) {
				if (error instanceof AdminSharedKeyConflictError) throw error
				throw sanitizeSharedKeyError(error)
			}
		},
	}
}
export type AdminSharedKeysApi = ReturnType<typeof createAdminSharedKeysApi>
