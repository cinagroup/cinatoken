/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import {
	CinaTokenApiError,
	createCinaTokenCookieTransport,
	type RequestOptions,
} from '../../api'
import {
	gatewayKeysListResponseSchema,
	type GatewayKeyRow,
} from '../gateway-keys/gateway-key-contracts'
import {
	createAdminSharedKeySubjectGate,
	SHARED_KEY_CONSOLE_SUBJECT_HEADER,
} from '../shared-keys/shared-key-subject'
import {
	simulatorContextSchema,
	simulatorVerifiedKeySchema,
} from './simulator-contracts'
import { simulatorKeyResourceIdSchema } from './simulator-search'

/** Gateway secrets are accepted only in memory, never in query/mutation keys. */
export function isOriginalGatewaySecret(value: string): boolean {
	return value.length <= 4096 && /^sk-[A-Za-z0-9_-]+$/u.test(value)
}
export function createSimulatorAdminApi(request: typeof fetch = fetch) {
	const transport = createCinaTokenCookieTransport(request)
	const checkSubject = createAdminSharedKeySubjectGate(request)
	const listSchema = gatewayKeysListResponseSchema.extend({
		page_size: z.literal(100),
	})
	function invalidResponse(): never {
		throw new CinaTokenApiError('Invalid response', 0, 'invalid-response')
	}
	return {
		async listKeys(
			input: { page: number; email: string },
			options: RequestOptions = {}
		) {
			if (
				!Number.isSafeInteger(input.page) ||
				input.page < 1 ||
				input.page > 1_000_000 ||
				input.email.length > 320 ||
				/\p{Cc}/u.test(input.email)
			)
				invalidResponse()
			const params = new URLSearchParams({
				page: String(input.page),
				page_size: '100',
				sort: 'created_at',
				order: 'desc',
			})
			if (input.email.trim()) params.set('email', input.email.trim())
			const result = await transport.send(
				'/api/admin/keys?' + params.toString(),
				listSchema,
				{},
				options
			)
			if (
				result.page !== input.page ||
				result.data.length > 100 ||
				result.data.length > result.total ||
				new Set(result.data.map((row) => row.id)).size !== result.data.length
			)
				invalidResponse()
			return result
		},
		async context(options: RequestOptions = {}) {
			const result = await transport.send(
				'/api/admin/simulator/context',
				simulatorContextSchema,
				{},
				options
			)
			return result.data
		},
		async verifySecret(
			key: Pick<GatewayKeyRow, 'id' | 'user_id' | 'workspace_id'>,
			secret: string,
			subject: string,
			options: RequestOptions = {}
		) {
			if (
				!isOriginalGatewaySecret(secret) ||
				!simulatorKeyResourceIdSchema.safeParse(key.id).success
			)
				throw new CinaTokenApiError('Gateway secret is invalid', 0, 'business')
			try {
				const expected = await checkSubject({
					...options,
					expectedConsoleSubject: subject,
				})
				options.signal?.throwIfAborted()
				const result = await transport.send(
					'/api/admin/keys/' + encodeURIComponent(key.id) + '/verify-secret',
					simulatorVerifiedKeySchema,
					{
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							[SHARED_KEY_CONSOLE_SUBJECT_HEADER]: expected,
						},
						body: JSON.stringify({ secret }),
					},
					options
				)
				options.signal?.throwIfAborted()
				if (
					result.data.id !== key.id ||
					result.data.user_id !== key.user_id ||
					result.data.workspace_id !== key.workspace_id
				)
					invalidResponse()
				return result.data
			} catch (error) {
				// No server-controlled text is allowed to retain or echo the supplied secret.
				if (options.signal?.aborted)
					throw new CinaTokenApiError('Request cancelled', 0, 'cancelled')
				const status = error instanceof CinaTokenApiError ? error.status : 0
				throw new CinaTokenApiError(
					'Gateway secret could not be verified',
					status,
					'business'
				)
			}
		},
	}
}
export type SimulatorAdminApi = ReturnType<typeof createSimulatorAdminApi>
export const simulatorAdminApi = createSimulatorAdminApi()
