/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	gatewayKeyDetailResponseSchema,
	gatewayKeyIdSchema,
	gatewayKeyRevisionSchema,
	gatewayKeyUpdatedResponseSchema,
	type GatewayKeyDetail,
} from '../gateway-keys/gateway-key-contracts'
import type { GatewayKeyPatch } from '../gateway-keys/gateway-key-input'
import type { UserDetailOptions, UserDetailTransport } from './user-detail-api'
import type { UserDetailKey } from './user-detail-contracts'

/** Shares the global Keys permission/revision contract; no read uses Query. */
export function createUserDetailKeyEditorApi(transport: UserDetailTransport) {
	function path(id: string): string {
		if (!gatewayKeyIdSchema.safeParse(id).success) transport.invalidResponse()
		return '/api/admin/keys/' + encodeURIComponent(id)
	}
	function ownership(
		actual: Pick<GatewayKeyDetail, 'id' | 'user_id' | 'workspace_id'>,
		expected: UserDetailKey
	): void {
		if (
			actual.id !== expected.id ||
			actual.user_id !== expected.user_id ||
			actual.workspace_id !== expected.workspace_id
		)
			transport.invalidResponse('Key ownership differs')
	}
	return {
		async userDetailKeyEditDetail(
			expected: UserDetailKey,
			options: UserDetailOptions = {}
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
		async saveUserDetailKeyEdit(
			expected: UserDetailKey,
			patch: GatewayKeyPatch,
			options: UserDetailOptions = {}
		): Promise<void> {
			if (!gatewayKeyRevisionSchema.safeParse(patch.expected_revision).success)
				transport.invalidResponse()
			try {
				options.signal?.throwIfAborted()
				const result = await transport.send(
					path(expected.id),
					gatewayKeyUpdatedResponseSchema,
					{
						method: 'PATCH',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(patch),
					},
					options
				)
				options.signal?.throwIfAborted()
				ownership(result.data, expected)
				if (
					(patch.name !== undefined && result.data.name !== patch.name) ||
					(patch.status !== undefined && result.data.status !== patch.status)
				)
					transport.invalidResponse()
			} catch (error) {
				throw transport.sanitizeError(error)
			}
		},
	}
}
