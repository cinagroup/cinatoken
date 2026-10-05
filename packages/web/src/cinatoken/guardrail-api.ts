import type { z } from 'zod'
import type { RequestOptions } from './api'
import {
	guardrailActionResponseSchema,
	guardrailAssignmentResponseSchema,
	guardrailAssignmentsResponseSchema,
	guardrailCreateInputSchema,
	guardrailEffectiveResponseSchema,
	guardrailIdentifier,
	guardrailListResponseSchema,
	guardrailPatchInputSchema,
	guardrailRowResponseSchema,
	guardrailVersionsResponseSchema,
	type Guardrail,
	type GuardrailAssignment,
	type GuardrailInput,
	type GuardrailPatch,
} from './guardrail-contracts'

export type GuardrailRequestOptions = RequestOptions & {
	expectedUserId: string
	expectedWorkspaceId: string
	expectedAccountScopeKey: string
}
type Send = <T>(
	path: string,
	schema: z.ZodType<T>,
	init: RequestInit,
	options: RequestOptions
) => Promise<T>
type GuardrailTransport = {
	send: Send
	sendEffective: Send
	checkWorkspace(actual: string, options: RequestOptions): void
	invalidResponse(message: string): never
}
export type GuardrailBinding = {
	scopeType: 'user' | 'api_key'
	scopeId: string
}
export function createGuardrailsApi(transport: GuardrailTransport) {
	function options(scope: GuardrailRequestOptions) {
		if (
			!scope.expectedUserId ||
			!scope.expectedWorkspaceId ||
			!scope.expectedAccountScopeKey
		)
			throw new TypeError('Guardrail account context required')
	}
	function check<
		T extends { workspaceId: string; userId: string; accountScopeKey: string },
	>(value: T, scope: GuardrailRequestOptions): T {
		transport.checkWorkspace(value.workspaceId, scope)
		if (
			value.userId !== scope.expectedUserId ||
			value.accountScopeKey !== scope.expectedAccountScopeKey
		)
			transport.invalidResponse('Server returned another Guardrail account')
		return value
	}
	function row(value: Guardrail, scope: GuardrailRequestOptions) {
		if (value.isAccountDefault) {
			if (value.accountScopeKey !== scope.expectedAccountScopeKey)
				transport.invalidResponse('Server returned another account default')
		} else if (
			value.workspaceId !== scope.expectedWorkspaceId ||
			value.ownerUserId !== scope.expectedUserId
		)
			transport.invalidResponse('Server returned another Guardrail owner')
		const writable =
			value.canEdit || value.canArchive || value.canRestore || value.canAssign
		if (
			(value.ownerUserId !== scope.expectedUserId ||
				value.workspaceId !== scope.expectedWorkspaceId) &&
			writable
		)
			transport.invalidResponse(
				'Foreign Guardrail cannot grant write permissions'
			)
		if (
			(value.adminManaged && writable) ||
			(value.status === 'archived' &&
				(value.canEdit || value.canAssign || value.canArchive)) ||
			(value.status === 'active' && value.canRestore)
		)
			transport.invalidResponse(
				'Read-only Guardrail cannot grant write permissions'
			)
		if (
			(value.isAccountDefault || value.isWorkspaceDefault) &&
			(value.canAssign || value.canArchive || value.canRestore)
		)
			transport.invalidResponse(
				'Default Guardrail cannot grant lifecycle permissions'
			)
	}
	function assignment(
		value: GuardrailAssignment,
		scope: GuardrailRequestOptions,
		id?: string
	) {
		if (
			value.workspaceId !== scope.expectedWorkspaceId ||
			(id && value.guardrailId !== id)
		)
			transport.invalidResponse('Server returned another Guardrail binding')
		if (
			value.canUnbind &&
			(value.createdByUserId !== scope.expectedUserId ||
				(value.scopeType === 'user' && value.scopeId !== scope.expectedUserId))
		)
			transport.invalidResponse(
				'Server returned unauthorized unbinding permission'
			)
	}
	const path = (id: string) =>
		`/api/user/guardrails/${encodeURIComponent(guardrailIdentifier.parse(id))}`
	const json = (method: string, value: unknown): RequestInit => ({
		method,
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(value),
	})
	async function write(
		id: string | null,
		suffix: string,
		input: unknown,
		method: string,
		scope: GuardrailRequestOptions
	) {
		options(scope)
		const value = await transport.send(
			id ? `${path(id)}${suffix}` : '/api/user/guardrails',
			guardrailRowResponseSchema,
			json(method, input),
			scope
		)
		check(value, scope)
		if (value.data) {
			row(value.data, scope)
			if (id && value.data.id !== id)
				transport.invalidResponse('Server returned another Guardrail')
		}
		return value
	}
	return {
		guardrails: async (scope: GuardrailRequestOptions) => {
			options(scope)
			const value = await transport.send(
				'/api/user/guardrails',
				guardrailListResponseSchema,
				{},
				scope
			)
			check(value.data, scope)
			value.data.guardrails.forEach((value) => row(value, scope))
			if (
				new Set(value.data.guardrails.map((value) => value.id)).size !==
				value.data.guardrails.length
			)
				transport.invalidResponse('Duplicate Guardrail records')
			return value.data
		},
		guardrailVersions: async (id: string, scope: GuardrailRequestOptions) => {
			options(scope)
			const value = check(
				await transport.send(
					`${path(id)}/versions`,
					guardrailVersionsResponseSchema,
					{},
					scope
				),
				scope
			)
			if (
				value.guardrailId !== id ||
				new Set(value.data.map((row) => row.version)).size !== value.data.length
			)
				transport.invalidResponse('Invalid Guardrail version identity')
			return value
		},
		guardrailAssignments: async (
			id: string,
			scope: GuardrailRequestOptions
		) => {
			options(scope)
			const value = check(
				await transport.send(
					`${path(id)}/assignments`,
					guardrailAssignmentsResponseSchema,
					{},
					scope
				),
				scope
			)
			if (value.guardrailId !== id)
				transport.invalidResponse('Server returned another Guardrail')
			value.data.forEach((value) => assignment(value, scope, id))
			if (new Set(value.data.map((row) => row.id)).size !== value.data.length)
				transport.invalidResponse('Duplicate Guardrail bindings')
			return value
		},
		createGuardrail: (input: GuardrailInput, scope: GuardrailRequestOptions) =>
			write(null, '', guardrailCreateInputSchema.parse(input), 'POST', scope),
		addGuardrailVersion: (
			id: string,
			input: GuardrailInput,
			scope: GuardrailRequestOptions
		) =>
			write(
				id,
				'/versions',
				guardrailCreateInputSchema.parse(input),
				'POST',
				scope
			),
		patchGuardrail: (
			id: string,
			input: GuardrailPatch,
			scope: GuardrailRequestOptions
		) => write(id, '', guardrailPatchInputSchema.parse(input), 'PATCH', scope),
		designateGuardrailVersion: (
			id: string,
			version: number,
			scope: GuardrailRequestOptions
		) => {
			if (!Number.isSafeInteger(version) || version < 1)
				throw new TypeError('Invalid Guardrail version')
			return write(id, '/designate', { version }, 'POST', scope)
		},
		archiveGuardrail: async (id: string, scope: GuardrailRequestOptions) => {
			options(scope)
			return check(
				await transport.send(
					path(id),
					guardrailActionResponseSchema,
					{ method: 'DELETE' },
					scope
				),
				scope
			)
		},
		bindGuardrail: async (
			id: string,
			binding: GuardrailBinding,
			scope: GuardrailRequestOptions
		) => {
			options(scope)
			if (binding.scopeType !== 'user' && binding.scopeType !== 'api_key')
				throw new TypeError('Invalid Guardrail binding scope')
			const scopeId = guardrailIdentifier.parse(binding.scopeId)
			if (binding.scopeType === 'user' && scopeId !== scope.expectedUserId)
				throw new TypeError('Cannot bind another user')
			const value = check(
				await transport.send(
					`${path(id)}/assignments`,
					guardrailAssignmentResponseSchema,
					json('PUT', { scope_type: binding.scopeType, scope_id: scopeId }),
					scope
				),
				scope
			)
			assignment(value.data, scope, id)
			if (
				value.data.scopeType !== binding.scopeType ||
				value.data.scopeId !== scopeId
			)
				transport.invalidResponse('Server returned another assignment scope')
			return value
		},
		unbindGuardrail: async (
			binding: GuardrailBinding,
			scope: GuardrailRequestOptions
		) => {
			options(scope)
			if (binding.scopeType !== 'user' && binding.scopeType !== 'api_key')
				throw new TypeError('Invalid Guardrail binding scope')
			const id = guardrailIdentifier.parse(binding.scopeId)
			if (binding.scopeType === 'user' && id !== scope.expectedUserId)
				throw new TypeError('Cannot unbind another user')
			return check(
				await transport.send(
					`/api/user/guardrails/assignments/${binding.scopeType}/${encodeURIComponent(id)}`,
					guardrailActionResponseSchema,
					{ method: 'DELETE' },
					scope
				),
				scope
			)
		},
		effectiveGuardrails: async (
			apiKeyId: string | null,
			scope: GuardrailRequestOptions
		) => {
			options(scope)
			const search = apiKeyId
				? `?${new URLSearchParams({ api_key_id: guardrailIdentifier.parse(apiKeyId) })}`
				: ''
			const value = await transport.sendEffective(
				`/api/user/guardrails/effective${search}`,
				guardrailEffectiveResponseSchema,
				{},
				scope
			)
			const context = value.success ? value.data : value
			check(context, scope)
			if (context.apiKeyId !== apiKeyId)
				transport.invalidResponse(
					'Server returned another effective Guardrail key'
				)
			return value
		},
	}
}
export type GuardrailsApi = ReturnType<typeof createGuardrailsApi>
