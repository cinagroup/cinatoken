import { z } from 'zod'
import type { RequestOptions } from './api'
import {
	BYOK_MAX_BODY_BYTES,
	byokIdSchema,
	byokKeyResponseSchema,
	byokListOptionsSchema,
	byokListResponseSchema,
	byokReorderResponseSchema,
	createByokKeyInputSchema,
	patchByokKeyInputSchema,
	reorderByokKeysInputSchema,
	type ByokKey,
	type ByokListOptions,
	type ByokListPage,
	type ByokReorderResult,
	type CreateByokKeyInput,
	type PatchByokKeyInput,
	type ReorderByokKeysInput,
} from './byok-contracts'
import { managementKeyAccountSchema } from './contracts'

export type ByokRequestOptions = RequestOptions & {
	expectedWorkspaceId: string
}

type ByokTransport = {
	send<T>(
		path: string,
		schema: z.ZodType<T>,
		init: RequestInit,
		options: RequestOptions
	): Promise<T>
	checkWorkspace(actual: string, options: RequestOptions): void
	invalidResponse(message: string): never
}

/** Uses the shared Cookie transport; BYOK plaintext is only an input, never a returned value. */
export function createByokApi(transport: ByokTransport) {
	function scope(options: ByokRequestOptions): void {
		z.string().min(1).max(600).parse(options.expectedWorkspaceId)
		if (options.expectedManagementAccount)
			managementKeyAccountSchema.parse(options.expectedManagementAccount)
		// Account identity is not part of this public response contract. The server
		// resolves it from the authorized workspace before enforcing the precondition.
	}

	function checkRow(row: ByokKey, options: ByokRequestOptions): ByokKey {
		transport.checkWorkspace(row.workspace_id, options)
		return row
	}

	function json(method: string, body: unknown): RequestInit {
		const serialized = JSON.stringify(body)
		if (new TextEncoder().encode(serialized).byteLength > BYOK_MAX_BODY_BYTES)
			throw new TypeError('BYOK request body is too large')
		return {
			method,
			headers: { 'Content-Type': 'application/json' },
			body: serialized,
		}
	}

	return {
		byokKeys: async (
			options: ByokRequestOptions & ByokListOptions
		): Promise<ByokListPage> => {
			scope(options)
			const page = byokListOptionsSchema.parse({
				offset: options.offset,
				limit: options.limit,
				provider: options.provider,
			})
			const query = new URLSearchParams({
				offset: String(page.offset),
				limit: String(page.limit),
			})
			if (page.provider !== undefined) query.set('provider', page.provider)
			const result = await transport.send(
				`/api/user/byok?${query}`,
				byokListResponseSchema,
				{},
				options
			)
			transport.checkWorkspace(result.workspaceId, options)
			if (
				result.data.length > page.limit ||
				(result.data.length > 0 &&
					result.total < page.offset + result.data.length) ||
				new Set(result.data.map((row) => row.id)).size !== result.data.length
			)
				transport.invalidResponse('Server returned an inconsistent BYOK page')
			result.data.forEach((row) => {
				checkRow(row, options)
				if (page.provider && row.provider !== page.provider)
					transport.invalidResponse('Server returned another BYOK provider')
			})
			return {
				data: result.data,
				total: result.total,
				workspaceId: result.workspaceId,
			}
		},
		byokKey: async (
			id: string,
			options: ByokRequestOptions
		): Promise<ByokKey> => {
			scope(options)
			const normalizedId = byokIdSchema.parse(id)
			const result = await transport.send(
				`/api/user/byok/${normalizedId}`,
				byokKeyResponseSchema,
				{},
				options
			)
			if (result.data.id !== normalizedId)
				transport.invalidResponse('Server returned another BYOK credential')
			return checkRow(result.data, options)
		},
		createByokKey: async (
			input: CreateByokKeyInput,
			options: ByokRequestOptions
		): Promise<ByokKey> => {
			scope(options)
			const body = createByokKeyInputSchema.parse(input)
			transport.checkWorkspace(
				body.workspace_id ?? options.expectedWorkspaceId,
				options
			)
			const result = await transport.send(
				'/api/user/byok',
				byokKeyResponseSchema,
				json('POST', body),
				options
			)
			if (result.data.provider !== body.provider)
				transport.invalidResponse('Server returned another BYOK provider')
			return checkRow(result.data, options)
		},
		updateByokKey: async (
			id: string,
			input: PatchByokKeyInput,
			options: ByokRequestOptions
		): Promise<ByokKey> => {
			scope(options)
			const normalizedId = byokIdSchema.parse(id)
			const body = patchByokKeyInputSchema.parse(input)
			const result = await transport.send(
				`/api/user/byok/${normalizedId}`,
				byokKeyResponseSchema,
				json('PATCH', body),
				options
			)
			if (result.data.id !== normalizedId)
				transport.invalidResponse('Server returned another BYOK credential')
			return checkRow(result.data, options)
		},
		deleteByokKey: async (
			id: string,
			options: ByokRequestOptions
		): Promise<void> => {
			scope(options)
			const normalizedId = byokIdSchema.parse(id)
			await transport.send(
				`/api/user/byok/${normalizedId}`,
				z
					.object({ success: z.literal(true), deleted: z.literal(true) })
					.strict(),
				{ method: 'DELETE' },
				options
			)
		},
		/** Input must represent the complete provider group, including disabled credentials. */
		reorderByokKeys: async (
			input: ReorderByokKeysInput,
			options: ByokRequestOptions
		): Promise<ByokReorderResult> => {
			scope(options)
			const body = reorderByokKeysInputSchema.parse(input)
			transport.checkWorkspace(
				body.workspace_id ?? options.expectedWorkspaceId,
				options
			)
			const result = await transport.send(
				'/api/user/byok/reorder',
				byokReorderResponseSchema,
				json('POST', body),
				options
			)
			transport.checkWorkspace(result.data.workspace_id, options)
			if (
				result.data.provider !== body.provider ||
				result.data.keys.length !== body.keys.length
			)
				transport.invalidResponse('Server returned another BYOK ordering')
			result.data.keys.forEach((row, index) => {
				const expected = body.keys[index]
				if (
					row.id !== expected.id ||
					row.is_fallback !== expected.is_fallback ||
					row.sort_order !== index
				)
					transport.invalidResponse(
						'Server returned an inconsistent BYOK ordering'
					)
			})
			return result.data
		},
	}
}
