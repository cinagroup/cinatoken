/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import { CinaTokenApiError, createCinaTokenCookieTransport } from '../../api'
import {
	createAdminDomainTransport,
	type AdminDomainRequestOptions,
	type AdminDomainTransport,
} from '../domain-transport'
import { AdminDomainWriteError } from '../domain-write-recovery'
import { adminGuardrailIdSchema } from './guardrails-contracts'
import {
	adminGuardrailPreviewResponseSchema,
	type AdminGuardrailPreviewResult,
} from './preview-contracts'

const shortId = adminGuardrailIdSchema.max(256)
const targetSchema = z.object({
	workspaceId: adminGuardrailIdSchema,
	userId: shortId,
	apiKeyId: shortId.nullable().optional(),
})
export type AdminGuardrailPreviewTarget = z.input<typeof targetSchema>
export type AdminGuardrailPreviewOptions = AdminDomainRequestOptions
function invalidResponse(): never {
	throw new CinaTokenApiError(
		'Guardrail preview response is invalid',
		200,
		'invalid-response'
	)
}
function sanitizeError(error: unknown): Error {
	if (error instanceof CinaTokenApiError)
		return new CinaTokenApiError(
			'Guardrail preview could not be confirmed',
			error.status,
			error.code,
			error.serverCode
		)
	return new CinaTokenApiError(
		'Guardrail preview could not be confirmed',
		0,
		'network'
	)
}
/** Bound read-only Console Cookie transport; effective-policy 409 is explicit business evidence. */
export function createAdminGuardrailPreviewApi(request: typeof fetch = fetch) {
	const cookie = createCinaTokenCookieTransport(request)
	const transport: AdminDomainTransport = {
		send(path, schema, init, options, reader) {
			return cookie.send(
				path,
				schema,
				init,
				options,
				reader,
				(response, body) =>
					response.status === 409 &&
					typeof body === 'object' &&
					body !== null &&
					'code' in body &&
					body.code === 'guardrail_effective_conflict' &&
					'success' in body &&
					body.success === false
			)
		},
		invalidResponse,
		sanitizeError,
	}
	const bound = createAdminDomainTransport(transport, 'guardrails')
	return {
		async previewGuardrail(
			target: AdminGuardrailPreviewTarget,
			options: AdminGuardrailPreviewOptions = {}
		): Promise<AdminGuardrailPreviewResult> {
			const parsed = targetSchema.safeParse(target)
			if (!parsed.success)
				throw new TypeError('Guardrail preview target is invalid')
			if (!options.expectedConsoleSubject)
				throw new AdminDomainWriteError('subject', 401)
			const { workspaceId, userId, apiKeyId = null } = parsed.data
			const query = new URLSearchParams({
				workspace_id: workspaceId,
				user_id: userId,
			})
			if (apiKeyId !== null) query.set('api_key_id', apiKeyId)
			const result = await bound.send(
				`/api/admin/guardrails/effective?${query.toString()}`,
				adminGuardrailPreviewResponseSchema,
				{ method: 'GET' },
				options
			)
			const scope = result.success ? result.data : result
			if (
				scope.workspaceId !== workspaceId ||
				scope.userId !== userId ||
				scope.apiKeyId !== apiKeyId
			)
				invalidResponse()
			if (result.success) return { kind: 'ready', preview: result.data }
			return {
				kind: 'conflict',
				code: result.code,
				workspaceId: result.workspaceId,
				userId: result.userId,
				accountScopeKey: result.accountScopeKey,
				apiKeyId: result.apiKeyId,
				budgetCurrency: result.budgetCurrency,
				pricingCurrency: result.pricingCurrency,
				trace: result.trace,
			}
		},
	}
}
export type AdminGuardrailPreviewApi = ReturnType<
	typeof createAdminGuardrailPreviewApi
>
