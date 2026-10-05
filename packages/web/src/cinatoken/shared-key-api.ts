import { z } from 'zod'
import type { RequestOptions } from './api'
import {
	createdSharedKeyResponseSchema,
	createSharedKeyInputSchema,
	patchSharedKeyInputSchema,
	sharedKeyChannelsResponseSchema,
	sharedKeyResponseSchema,
	sharedKeysResponseSchema,
	type CreatedSharedKey,
	type CreateSharedKeyInput,
	type PatchSharedKeyInput,
	type SharedKey,
	type SharedKeyCatalog,
	type SharedKeyCollection,
} from './shared-key-contracts'

export type SharedKeyRequestOptions = RequestOptions & {
	expectedSellerUserId: string
	expectedWorkspaceId: string
}
type SharedKeyTransport = {
	send<T>(
		path: string,
		schema: z.ZodType<T>,
		init: RequestInit,
		options: RequestOptions
	): Promise<T>
	invalidResponse(message: string): never
	sanitizeError(error: unknown): unknown
}

export class SharedKeyHistoryConflict extends Error {
	readonly status = 409
	constructor() {
		super('Credited shared-key history cannot be deleted')
		this.name = 'SharedKeyHistoryConflict'
	}
}

/** Seller ownership is global to the signed-in user; workspace is only a session precondition. */
export function createSharedKeyApi(transport: SharedKeyTransport) {
	function seller(options: SharedKeyRequestOptions) {
		z.string().trim().min(1).max(600).parse(options.expectedSellerUserId)
		// The workspace does not own this listing, but Cookie changes must never redirect a write.
		z.string().trim().min(1).max(600).parse(options.expectedWorkspaceId)
	}
	function check(row: SharedKey, options: SharedKeyRequestOptions): SharedKey {
		if (row.sellerUserId !== options.expectedSellerUserId)
			transport.invalidResponse('Server returned another seller')
		return row
	}
	function body(method: string, input: unknown): RequestInit {
		const serialized = JSON.stringify(input)
		if (new TextEncoder().encode(serialized).byteLength > 2 * 1024 * 1024)
			throw new TypeError('Shared key request exceeds the server body limit')
		return {
			method,
			headers: { 'Content-Type': 'application/json' },
			body: serialized,
		}
	}
	async function safe<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation()
		} catch (error) {
			// Never retain a server message that could echo an input credential.
			throw transport.sanitizeError(error)
		}
	}
	function id(value: string): string {
		return encodeURIComponent(z.string().trim().min(1).max(600).parse(value))
	}
	return {
		sharedKeys: async (
			options: SharedKeyRequestOptions
		): Promise<SharedKeyCollection> =>
			safe(async () => {
				seller(options)
				const result = await transport.send(
					'/api/user/shared-keys',
					sharedKeysResponseSchema,
					{},
					options
				)
				if (
					result.sellerUserId !== options.expectedSellerUserId ||
					new Set(result.data.map((row) => row.id)).size !== result.data.length
				)
					transport.invalidResponse(
						'Server returned an inconsistent seller collection'
					)
				return {
					keys: result.data.map((row) => check(row, options)),
					earningsCurrency: result.earningsCurrency,
				}
			}),
		sharedKeyChannels: async (
			options: SharedKeyRequestOptions
		): Promise<SharedKeyCatalog> =>
			safe(async () => {
				seller(options)
				const result = await transport.send(
					'/api/user/shared-keys/channels',
					sharedKeyChannelsResponseSchema,
					{},
					options
				)
				if (
					new Set(result.data.channels.map((channel) => channel.channelType))
						.size !== result.data.channels.length
				)
					transport.invalidResponse('Server returned duplicate channels')
				return result.data
			}),
		createSharedKey: async (
			input: CreateSharedKeyInput,
			options: SharedKeyRequestOptions
		): Promise<CreatedSharedKey> =>
			safe(async () => {
				seller(options)
				const normalized = createSharedKeyInputSchema.parse(input)
				const result = await transport.send(
					'/api/user/shared-keys',
					createdSharedKeyResponseSchema,
					body('POST', normalized),
					{ ...options, timeoutMs: options.timeoutMs ?? 30_000 }
				)
				const { apiKey, validation, validationReason, ...row } = result.data
				check(row, options)
				if (
					row.channelType !== normalized.channelType ||
					apiKey !== normalized.apiKey
				)
					transport.invalidResponse(
						'Server returned another created shared key'
					)
				return { row, validation, validationReason }
			}),
		updateSharedKey: async (
			keyId: string,
			input: PatchSharedKeyInput,
			options: SharedKeyRequestOptions
		): Promise<SharedKey> =>
			safe(async () => {
				seller(options)
				const result = await transport.send(
					`/api/user/shared-keys/${id(keyId)}`,
					sharedKeyResponseSchema,
					body('PATCH', patchSharedKeyInputSchema.parse(input)),
					options
				)
				if (result.data.id !== keyId)
					transport.invalidResponse('Server returned another shared key')
				return check(result.data, options)
			}),
		revalidateSharedKey: async (
			keyId: string,
			options: SharedKeyRequestOptions
		): Promise<SharedKey> =>
			safe(async () => {
				seller(options)
				const result = await transport.send(
					`/api/user/shared-keys/${id(keyId)}/revalidate`,
					sharedKeyResponseSchema,
					{ method: 'POST' },
					{ ...options, timeoutMs: options.timeoutMs ?? 30_000 }
				)
				if (result.data.id !== keyId)
					transport.invalidResponse('Server returned another shared key')
				return check(result.data, options)
			}),
		deleteSharedKey: async (
			keyId: string,
			options: SharedKeyRequestOptions
		): Promise<void> => {
			try {
				await safe(async () => {
					seller(options)
					await transport.send(
						`/api/user/shared-keys/${id(keyId)}`,
						z.object({ success: z.literal(true) }).strict(),
						{ method: 'DELETE' },
						options
					)
				})
			} catch (error) {
				// Only the explicit history guard supports the pause-instead recovery flow.
				if (
					error instanceof Error &&
					'status' in error &&
					error.status === 409 &&
					'serverCode' in error &&
					error.serverCode === 'shared_key_earning_history_immutable'
				)
					throw new SharedKeyHistoryConflict()
				throw error
			}
		},
	}
}
