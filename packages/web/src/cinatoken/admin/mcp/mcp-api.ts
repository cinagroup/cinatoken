/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import { CinaTokenApiError } from '../../api'
import {
	ADMIN_DOMAIN_SUBJECT_HEADER,
	createAdminDomainTransport,
	type AdminDomainRequestOptions,
	type AdminDomainTransport,
} from '../domain-transport'
import { AdminDomainWriteError } from '../domain-write-recovery'
import {
	projectUserDisplay,
	usersDisplayResponseSchema,
	type UserDisplay,
} from '../users/users-display'
import {
	mcpCreateResponseSchema,
	mcpDeleteResponseSchema,
	mcpDetailResponseSchema,
	mcpIdResponseSchema,
	mcpIdSchema,
	mcpListResponseSchema,
	mcpPricingSchema,
	mcpSecretsResponseSchema,
	mcpStatusResponseSchema,
	mcpSyncResponseSchema,
	mcpTestResponseSchema,
	type McpPricingRule,
	type McpServer,
	type McpServerSummary,
} from './mcp-contracts'
import {
	McpInputError,
	mcpCreateInput,
	mcpUpdateInput,
	type McpServerDraft,
} from './mcp-input'

export type McpRequestOptions = AdminDomainRequestOptions
export type McpAdminTransport = AdminDomainTransport
const root = '/api/admin/mcp-servers'
const maxBytes = 16 * 1024 * 1024
const json = (method: string, value: unknown): RequestInit => ({
	method,
	headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify(value),
})
const currencySchema = z.object({
	success: z.literal(true),
	data: z.object({
		billingCurrency: z.object({
			value: z.string().max(80).nullable(),
			source: z.enum(['configured', 'missing', 'invalid', 'unsupported']),
		}),
	}),
})
function invalidResponse(): never {
	throw new CinaTokenApiError('Invalid MCP response', 200, 'invalid-response')
}
function safeError(error: unknown): Error {
	if (error instanceof CinaTokenApiError)
		return new CinaTokenApiError(
			'MCP request could not be confirmed',
			error.status,
			error.code
		)
	return new Error('MCP request could not be confirmed')
}
async function boundedJson(response: Response): Promise<unknown> {
	const length = response.headers.get('content-length')
	if (length && Number(length) > maxBytes) {
		void response.body?.cancel().catch(() => undefined)
		invalidResponse()
	}
	if (!response.body) invalidResponse()
	const reader = response.body.getReader()
	const decoder = new TextDecoder('utf-8', { fatal: true })
	let bytes = 0
	let raw = ''
	let done = false
	try {
		while (true) {
			const chunk = await reader.read()
			if (chunk.done) {
				done = true
				break
			}
			bytes += chunk.value.byteLength
			if (bytes > maxBytes) invalidResponse()
			raw += decoder.decode(chunk.value, { stream: true })
		}
		raw += decoder.decode()
		return JSON.parse(raw) as unknown
	} finally {
		if (!done) void reader.cancel().catch(() => undefined)
		reader.releaseLock()
	}
}
function id(value: unknown): string {
	const checked = mcpIdSchema.safeParse(value)
	if (!checked.success) throw new McpInputError('id', 'invalid')
	return checked.data
}
function serverPath(value: string): string {
	return root + '/' + encodeURIComponent(id(value))
}

/** Real MCP ACKs are validated here; the legacy backend has no generic domain ACK envelope. */
export function createAdminMcpApi(transport: McpAdminTransport) {
	const domain = createAdminDomainTransport(transport, 'mcp')
	async function send<T>(
		path: string,
		schema: z.ZodType<T>,
		init: RequestInit,
		options: McpRequestOptions,
		operation?: string,
		acknowledge?: (value: T) => boolean
	): Promise<T> {
		let dispatched = false
		try {
			options.signal?.throwIfAborted()
			const headers = new Headers(init.headers)
			if (operation) {
				if (typeof options.onDispatch !== 'function')
					throw new AdminDomainWriteError('storage')
				headers.set(
					ADMIN_DOMAIN_SUBJECT_HEADER,
					await domain.verifyAdminDomainSubject(options)
				)
				options.signal?.throwIfAborted()
				try {
					options.onDispatch(operation)
				} catch {
					throw new AdminDomainWriteError('storage')
				}
				dispatched = true
			} else if (options.expectedConsoleSubject !== undefined) {
				const subject = options.expectedConsoleSubject
				if (
					!subject ||
					subject.length > 600 ||
					subject.trim() !== subject ||
					/[\p{Cc}\p{Cf}]/u.test(subject)
				)
					throw new AdminDomainWriteError('subject', 401)
				headers.set(ADMIN_DOMAIN_SUBJECT_HEADER, encodeURIComponent(subject))
			}
			const raw = await transport.send(
				path,
				z.unknown(),
				{ ...init, headers },
				{ signal: options.signal, timeoutMs: options.timeoutMs },
				boundedJson
			)
			options.signal?.throwIfAborted()
			const parsed = schema.safeParse(raw)
			if (!parsed.success || (acknowledge && !acknowledge(parsed.data)))
				invalidResponse()
			return parsed.data
		} catch (error) {
			if (error instanceof AdminDomainWriteError) throw error
			if (!operation) throw safeError(error)
			if (!dispatched) throw new AdminDomainWriteError('subject', 401)
			let rejected = [400, 401, 403, 404, 405, 409, 412, 413, 422, 428]
			// Sync may persist part of a catalog and then report a 400 upstream failure.
			if (operation === 'sync') rejected = [401, 403, 404, 405, 413]
			if (
				error instanceof CinaTokenApiError &&
				error.code === 'http' &&
				rejected.includes(error.status)
			)
				throw new AdminDomainWriteError('rejected', error.status)
			throw new AdminDomainWriteError(
				'unknown',
				error instanceof CinaTokenApiError ? error.status : 0
			)
		}
	}
	return {
		verifyMcpSubject: domain.verifyAdminDomainSubject,
		async mcpDisplay(options: McpRequestOptions = {}): Promise<UserDisplay> {
			const result = await send(
				'/api/admin/config/overview',
				usersDisplayResponseSchema,
				{},
				options
			)
			return projectUserDisplay(result.data)
		},
		async mcpCurrency(
			options: McpRequestOptions = {}
		): Promise<'USD' | 'CNY' | null> {
			try {
				const result = await send(
					'/api/admin/config/overview',
					currencySchema,
					{},
					options
				)
				const billing = result.data.billingCurrency
				if (billing.source === 'missing' && billing.value === 'USD')
					return 'USD'
				if (
					billing.source === 'configured' &&
					(billing.value === 'USD' || billing.value === 'CNY')
				)
					return billing.value
				return null
			} catch (error) {
				if (options.signal?.aborted) throw safeError(error)
				return null
			}
		},
		async listMcpServers(
			options: McpRequestOptions = {}
		): Promise<McpServerSummary[]> {
			const result = await send(
				root,
				mcpListResponseSchema,
				{},
				options,
				undefined,
				(value) =>
					new Set(value.data.map((row) => row.id)).size === value.data.length &&
					new Set(value.data.map((row) => row.slug)).size === value.data.length
			)
			return result.data
		},
		async getMcpServer(serverId: string, options: McpRequestOptions = {}) {
			const expectedId = id(serverId)
			const result = await send(
				serverPath(expectedId),
				mcpDetailResponseSchema,
				{},
				options,
				undefined,
				(value) =>
					value.data.server.id === expectedId &&
					value.data.items.every((item) => item.serverId === expectedId) &&
					new Set(value.data.items.map((item) => item.id)).size ===
						value.data.items.length
			)
			return result.data
		},
		async createMcpServer(
			draft: McpServerDraft,
			options: McpRequestOptions = {}
		) {
			const body = mcpCreateInput(draft)
			const result = await send(
				root,
				mcpCreateResponseSchema,
				json('POST', body),
				options,
				'create',
				(value) => value.data.slug === body.slug
			)
			return result.data
		},
		async updateMcpServer(
			serverId: string,
			draft: McpServerDraft,
			current: McpServer,
			options: McpRequestOptions = {}
		) {
			const expectedId = id(serverId)
			if (current.id !== expectedId) throw new McpInputError('id', 'invalid')
			const body = mcpUpdateInput(draft, current)
			const result = await send(
				serverPath(expectedId),
				mcpIdResponseSchema,
				json('PATCH', body),
				options,
				'update',
				(value) => value.data.id === expectedId
			)
			return result.data
		},
		async deleteMcpServer(
			serverId: string,
			options: McpRequestOptions = {}
		): Promise<void> {
			await send(
				serverPath(serverId),
				mcpDeleteResponseSchema,
				{ method: 'DELETE' },
				options,
				'delete'
			)
		},
		async revealMcpServer(serverId: string, options: McpRequestOptions = {}) {
			const path = serverPath(serverId) + '/reveal'
			const subject = await domain.verifyAdminDomainSubject(options)
			options.signal?.throwIfAborted()
			const result = await send(
				path,
				mcpSecretsResponseSchema,
				{ headers: { [ADMIN_DOMAIN_SUBJECT_HEADER]: subject } },
				options
			)
			return result.data
		},
		async testMcpServer(serverId: string, options: McpRequestOptions = {}) {
			const result = await send(
				serverPath(serverId) + '/test',
				mcpTestResponseSchema,
				{ method: 'POST' },
				options,
				'test'
			)
			return result.data
		},
		async syncMcpServer(serverId: string, options: McpRequestOptions = {}) {
			const result = await send(
				serverPath(serverId) + '/sync',
				mcpSyncResponseSchema,
				{ method: 'POST' },
				options,
				'sync'
			)
			return result.data
		},
		async setMcpItemStatus(
			serverId: string,
			ids: string[],
			status: 'enabled' | 'disabled',
			options: McpRequestOptions = {}
		) {
			const checked = z
				.object({
					ids: z
						.array(mcpIdSchema)
						.min(1)
						.max(25_000)
						.refine((values) => new Set(values).size === values.length),
					status: z.enum(['enabled', 'disabled']),
				})
				.safeParse({ ids, status })
			if (!checked.success) throw new McpInputError('items', 'invalid')
			const result = await send(
				serverPath(serverId) + '/items/status',
				mcpStatusResponseSchema,
				json('POST', checked.data),
				options,
				'status',
				(value) => value.data.updated === ids.length
			)
			return result.data
		},
		async setMcpItemPricing(
			serverId: string,
			itemId: string,
			pricing: McpPricingRule | null,
			options: McpRequestOptions = {}
		) {
			const expectedId = id(itemId)
			const checked = mcpPricingSchema.nullable().safeParse(pricing)
			if (!checked.success) throw new McpInputError('pricing', 'invalidPricing')
			const result = await send(
				serverPath(serverId) + '/items/' + encodeURIComponent(expectedId),
				mcpIdResponseSchema,
				json('PATCH', { pricing: checked.data }),
				options,
				'pricing',
				(value) => value.data.id === expectedId
			)
			return result.data
		},
		async acceptMcpItemChange(
			serverId: string,
			itemId: string,
			options: McpRequestOptions = {}
		) {
			const expectedId = id(itemId)
			const result = await send(
				serverPath(serverId) +
					'/items/' +
					encodeURIComponent(expectedId) +
					'/accept',
				mcpIdResponseSchema,
				{ method: 'POST' },
				options,
				'accept',
				(value) => value.data.id === expectedId
			)
			return result.data
		},
	}
}
export type AdminMcpApi = ReturnType<typeof createAdminMcpApi>
