/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { z } from 'zod'
import {
	accessKeyPublicSchema,
	accessKeyIdSchema,
	accessKeyDraftSchema,
	accessKeyPatchSchema,
	accessKeyResponseSchema,
	accessKeySecretResponseSchema,
	accessKeysResponseSchema,
	accessKeyWriteSecretResponseSchema,
	type AccessKey,
	type AccessKeyDraft,
	type AccessKeyPatch,
} from './access-key-contracts'

type Options = { signal?: AbortSignal; timeoutMs?: number }
export type AccessKeyTransport = {
	send<T>(
		path: string,
		schema: z.ZodType<T>,
		init: RequestInit,
		options: Options
	): Promise<T>
	invalidResponse(message?: string): never
	sanitizeError(error: unknown): Error
}

export function createAdminAccessKeysApi(transport: AccessKeyTransport) {
	async function send<T>(
		path: string,
		schema: z.ZodType<T>,
		init: RequestInit = {},
		options: Options = {}
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
	function json(method: 'POST' | 'PATCH', payload: object): RequestInit {
		return {
			method,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		}
	}
	function keyPath(keyId: string): string {
		if (!accessKeyIdSchema.safeParse(keyId).success) transport.invalidResponse()
		return '/api/admin/access-keys/' + encodeURIComponent(keyId)
	}
	function publicKey(row: unknown): AccessKey {
		const parsed = accessKeyPublicSchema.safeParse(row)
		if (!parsed.success) transport.invalidResponse()
		return parsed.data
	}
	function confirmPatch(row: AccessKey, patch: AccessKeyPatch): void {
		if (
			(patch.name !== undefined && row.name !== patch.name) ||
			(patch.description !== undefined &&
				row.description !== patch.description) ||
			(patch.status !== undefined && row.status !== patch.status) ||
			(patch.permissions !== undefined &&
				(row.permissions.length !== patch.permissions.length ||
					patch.permissions.some(
						(permission) => !row.permissions.includes(permission)
					)))
		)
			transport.invalidResponse()
	}
	return {
		async listAccessKeys(options: Options = {}): Promise<AccessKey[]> {
			const result = await send(
				'/api/admin/access-keys',
				accessKeysResponseSchema,
				{},
				options
			)
			return result.data
		},
		async revealAccessKey(
			keyId: string,
			options: Options = {}
		): Promise<string> {
			const result = await send(
				keyPath(keyId) + '/secret',
				accessKeySecretResponseSchema,
				{},
				options
			)
			if (result.data.id !== keyId) transport.invalidResponse()
			return result.data.key
		},
		async createAccessKey(input: AccessKeyDraft): Promise<AccessKey> {
			if (!accessKeyDraftSchema.safeParse(input).success || !input.secret_key)
				transport.invalidResponse()
			const result = await send(
				'/api/admin/access-keys',
				accessKeyWriteSecretResponseSchema,
				json('POST', input)
			)
			if (result.data.key !== input.secret_key) transport.invalidResponse()
			const row = publicKey({
				...result.data,
				key: result.data.key_prefix + '••••••••',
			})
			confirmPatch(row, { ...input, status: 'active' })
			return row
		},
		async patchAccessKey(
			keyId: string,
			patch: AccessKeyPatch
		): Promise<AccessKey> {
			const path = keyPath(keyId)
			if (!accessKeyPatchSchema.safeParse(patch).success)
				transport.invalidResponse()
			if (patch.secret_key) {
				const result = await send(
					path,
					accessKeyWriteSecretResponseSchema,
					json('PATCH', patch)
				)
				if (result.data.id !== keyId || result.data.key !== patch.secret_key)
					transport.invalidResponse()
				const row = publicKey({
					...result.data,
					key: result.data.key_prefix + '••••••••',
				})
				confirmPatch(row, patch)
				return row
			}
			const result = await send(
				path,
				accessKeyResponseSchema,
				json('PATCH', patch)
			)
			if (result.data.id !== keyId) transport.invalidResponse()
			confirmPatch(result.data, patch)
			return result.data
		},
	}
}
export type AdminAccessKeysApi = ReturnType<typeof createAdminAccessKeysApi>
