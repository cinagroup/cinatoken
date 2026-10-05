/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { UsersTransport, UsersRequestOptions } from '../users/users-api'
import {
	gatewayKeyCreatedResponseSchema,
	gatewayKeyDetailResponseSchema,
	gatewayKeyIdSchema,
	gatewayKeyRevisionSchema,
	gatewayKeysListResponseSchema,
	gatewayKeyUpdatedResponseSchema,
	type GatewayKeyCreated,
	type GatewayKeyDetail,
	type GatewayKeyRow,
} from './gateway-key-contracts'
import {
	gatewayKeyCreateInput,
	type GatewayKeyCreateForm,
	type GatewayKeyPatch,
} from './gateway-key-input'
import {
	gatewayKeysListPath,
	type GatewayKeySearch,
} from './gateway-key-search'

export function createAdminGatewayKeysApi(transport: UsersTransport) {
	function path(id: string): string {
		if (!gatewayKeyIdSchema.safeParse(id).success) transport.invalidResponse()
		return '/api/admin/keys/' + encodeURIComponent(id)
	}
	function ownership(
		row: Pick<GatewayKeyRow, 'id' | 'user_id' | 'workspace_id'>,
		expected: Pick<GatewayKeyRow, 'id' | 'user_id' | 'workspace_id'>
	): void {
		if (
			row.id !== expected.id ||
			row.user_id !== expected.user_id ||
			row.workspace_id !== expected.workspace_id
		)
			transport.invalidResponse()
	}
	function json(
		method: 'POST' | 'PATCH' | 'DELETE',
		body: object
	): RequestInit {
		return {
			method,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		}
	}
	return {
		async gatewayKeyList(
			search: GatewayKeySearch,
			options: UsersRequestOptions = {}
		) {
			try {
				options.signal?.throwIfAborted()
				const result = await transport.send(
					gatewayKeysListPath(search),
					gatewayKeysListResponseSchema,
					{},
					options
				)
				options.signal?.throwIfAborted()
				if (
					result.page !== search.page ||
					result.data.length > result.total ||
					new Set(result.data.map((row) => row.id)).size !==
						result.data.length ||
					result.data.some(
						(row) => search.user_id && row.user_id !== search.user_id
					)
				)
					transport.invalidResponse()
				return result
			} catch (error) {
				throw transport.sanitizeError(error)
			}
		},
		async gatewayKeyEditDetail(
			expected: GatewayKeyRow,
			options: UsersRequestOptions = {}
		): Promise<GatewayKeyDetail> {
			try {
				options.signal?.throwIfAborted()
				const result = await transport.send(
					path(expected.id),
					gatewayKeyDetailResponseSchema,
					{},
					options
				)
				options.signal?.throwIfAborted()
				ownership(result.data, expected)
				return result.data
			} catch (error) {
				throw transport.sanitizeError(error)
			}
		},
		async createGatewayKey(
			draft: GatewayKeyCreateForm,
			onSecret: (secret: string) => void,
			options: UsersRequestOptions = {}
		): Promise<GatewayKeyCreated> {
			const input = gatewayKeyCreateInput(draft)
			try {
				const result = await transport.send(
					'/api/admin/keys',
					gatewayKeyCreatedResponseSchema,
					json('POST', input),
					options
				)
				options.signal?.throwIfAborted()
				const row = result.data
				if (
					row.id !== row.key_id ||
					row.workspace_id !== 'personal:' + row.user_id ||
					row.name !== input.name ||
					(input.user_id !== undefined && row.user_id !== input.user_id) ||
					(input.external_system !== undefined &&
						(row.owner.external_system !== input.external_system ||
							row.owner.external_user_id !== input.external_user_id))
				)
					transport.invalidResponse()
				const { key, ...publicResult } = row
				onSecret(key)
				return publicResult
			} catch (error) {
				throw transport.sanitizeError(error)
			}
		},
		async patchGatewayKey(
			expected: GatewayKeyRow,
			input: GatewayKeyPatch,
			options: UsersRequestOptions = {}
		): Promise<GatewayKeyRow> {
			if (!gatewayKeyRevisionSchema.safeParse(input.expected_revision).success)
				transport.invalidResponse()
			try {
				const result = await transport.send(
					path(expected.id),
					gatewayKeyUpdatedResponseSchema,
					json('PATCH', input),
					options
				)
				options.signal?.throwIfAborted()
				ownership(result.data, expected)
				if (
					(input.name !== undefined && result.data.name !== input.name) ||
					(input.status !== undefined && result.data.status !== input.status)
				)
					transport.invalidResponse()
				return result.data
			} catch (error) {
				throw transport.sanitizeError(error)
			}
		},
		async tombstoneGatewayKey(
			expected: GatewayKeyRow,
			reason: string,
			options: UsersRequestOptions = {}
		): Promise<GatewayKeyRow> {
			try {
				const result = await transport.send(
					path(expected.id),
					gatewayKeyUpdatedResponseSchema,
					json('DELETE', {
						expected_revision: expected.profile_revision,
						reason,
					}),
					options
				)
				options.signal?.throwIfAborted()
				ownership(result.data, expected)
				if (result.data.status !== 'revoked') transport.invalidResponse()
				return result.data
			} catch (error) {
				throw transport.sanitizeError(error)
			}
		},
	}
}
export type AdminGatewayKeysApi = ReturnType<typeof createAdminGatewayKeysApi>
