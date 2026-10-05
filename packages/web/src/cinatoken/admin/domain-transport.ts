/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import { CinaTokenApiError } from '../api'
import { authCheckSchema, portalMeSchema } from '../contracts'
import {
	AdminDomainWriteError,
	type AdminWriteDomain,
} from './domain-write-recovery'

export const ADMIN_DOMAIN_SUBJECT_HEADER =
	'X-CinaToken-Expected-Console-Subject'
export type AdminDomainRequestOptions = {
	signal?: AbortSignal
	timeoutMs?: number
	expectedConsoleSubject?: string
	expectedUserId?: string
	onDispatch?: (operation: string) => void
}
export type AdminDomainTransport = {
	send<T>(
		path: string,
		schema: z.ZodType<T>,
		init: RequestInit,
		options: AdminDomainRequestOptions,
		reader?: (response: Response) => Promise<unknown>
	): Promise<T>
	invalidResponse(message: string): never
	sanitizeError(error: unknown): Error
}
function encodedSubject(options: AdminDomainRequestOptions): string {
	const subject = options.expectedConsoleSubject
	if (
		typeof subject !== 'string' ||
		!subject ||
		subject.length > 600 ||
		subject.trim() !== subject ||
		/[\p{Cc}\p{Cf}]/u.test(subject)
	)
		throw new AdminDomainWriteError('subject', 401)
	return encodeURIComponent(subject)
}
function operation(path: string, method: string): string {
	path = path.split('?')[0]!
	if (path.endsWith('/designate')) return 'designate'
	if (path.startsWith('/api/admin/guardrails/')) {
		if (method === 'PUT' && path.endsWith('/assignments')) return 'bind'
		if (method === 'DELETE' && path.includes('/assignments/')) return 'unbind'
	}
	if (path.endsWith('/import')) return 'import'
	if (path.includes('/dashscope/')) return 'resource'
	if (path.endsWith('/bootstrap/deepseek')) return 'bootstrap'
	if (path.includes('/sticky/bindings/')) return 'clear-sticky'
	if (path.endsWith('/sticky/reset')) return 'reset-sticky'
	if (path.includes('/pools/')) return 'policy'
	if (path.includes('/routes/') && path.startsWith('/api/admin/endpoints/'))
		return method === 'DELETE' ? 'unlink' : 'link'
	if (method === 'POST') return 'create'
	return method === 'DELETE' ? 'delete' : 'update'
}
function expectedAcknowledgement(
	path: string,
	method: string,
	domain: AdminWriteDomain,
	init: RequestInit
) {
	const parts = path.split('?')[0]!.split('/').slice(4).map(decodeURIComponent)
	const op = operation(path, method)
	let id: string | undefined
	let related_id: string | undefined
	if (!['import', 'bootstrap'].includes(op)) {
		id = parts[0]
		if (domain === 'routes' && parts[0] === 'pools') {
			id = parts[1]
			if (op === 'clear-sticky') related_id = parts[4]
		} else if (op === 'resource' || op === 'link' || op === 'unlink')
			related_id = parts[2]
		else if (domain === 'guardrails' && op === 'bind') {
			const body = z
				.object({ scope_id: z.string().min(1) })
				.parse(
					JSON.parse(typeof init.body === 'string' ? init.body : '') as unknown
				)
			related_id = body.scope_id
		} else if (domain === 'guardrails' && op === 'unbind') {
			id =
				new URL(path, 'https://console.invalid').searchParams.get(
					'expected_guardrail_id'
				) ?? undefined
			related_id = parts[2]
			if (!id) throw new Error('Missing expected guardrail ID')
		}
	}
	return { domain, operation: op, id, related_id }
}
export function createAdminDomainTransport(
	transport: AdminDomainTransport,
	domain: AdminWriteDomain
) {
	async function verifyAdminDomainSubject(
		options: AdminDomainRequestOptions
	): Promise<string> {
		try {
			const header = encodedSubject(options)
			if (typeof options.expectedUserId !== 'string' || !options.expectedUserId)
				throw new Error('Missing identity')
			options.signal?.throwIfAborted()
			const safeOptions = {
				signal: options.signal,
				timeoutMs: options.timeoutMs,
			}
			const check = await transport.send(
				'/api/auth/check',
				authCheckSchema,
				{},
				safeOptions
			)
			options.signal?.throwIfAborted()
			if (
				!check.authenticated ||
				check.verification !== 'verified' ||
				check.principalType !== 'console' ||
				check.subject !== options.expectedConsoleSubject
			)
				throw new Error('Console subject changed')
			const me = await transport.send(
				'/api/user/me',
				z.object({ success: z.literal(true), data: portalMeSchema }),
				{},
				safeOptions
			)
			options.signal?.throwIfAborted()
			if (
				me.data.userId !== options.expectedUserId ||
				me.data.subject !== options.expectedConsoleSubject ||
				!me.data.isAdmin
			)
				throw new Error('Portal association changed')
			return header
		} catch {
			throw new AdminDomainWriteError('subject', 401)
		}
	}
	async function send<T>(
		path: string,
		schema: z.ZodType<T>,
		init: RequestInit,
		options: AdminDomainRequestOptions
	): Promise<T> {
		const method = (init.method ?? 'GET').toUpperCase()
		const writing = method !== 'GET' && method !== 'HEAD'
		let dispatched = false
		let responseAcknowledgement: unknown
		try {
			options.signal?.throwIfAborted()
			const expected = writing
				? expectedAcknowledgement(path, method, domain, init)
				: null
			const headers = new Headers(init.headers)
			if (writing) {
				if (typeof options.onDispatch !== 'function')
					throw new AdminDomainWriteError('storage')
				headers.set(
					ADMIN_DOMAIN_SUBJECT_HEADER,
					await verifyAdminDomainSubject(options)
				)
				options.signal?.throwIfAborted()
				options.onDispatch(operation(path, method))
				dispatched = true
			} else if (options.expectedConsoleSubject !== undefined)
				headers.set(ADMIN_DOMAIN_SUBJECT_HEADER, encodedSubject(options))
			const result = await transport.send(
				path,
				z.unknown(),
				{
					...init,
					headers: headers.entries().next().done ? init.headers : headers,
				},
				{ signal: options.signal, timeoutMs: options.timeoutMs },
				async (response) => {
					const body: unknown = await response.json()
					if (writing && path.includes('/dashscope/')) {
						const raw = response.headers.get('X-CinaToken-Acknowledgement')
						if (
							raw === null ||
							typeof body !== 'object' ||
							body === null ||
							Array.isArray(body)
						)
							transport.invalidResponse('Missing provider acknowledgement')
						responseAcknowledgement = JSON.parse(raw) as unknown
						return body
					}
					return body
				}
			)
			options.signal?.throwIfAborted()
			if (writing && expected) {
				const actual = z
					.object({
						acknowledgement: z
							.object({
								domain: z.literal(domain),
								operation: z.string(),
								id: z.string().min(1).optional(),
								related_id: z.string().min(1).optional(),
							})
							.strict(),
					})
					.safeParse(
						path.includes('/dashscope/')
							? { acknowledgement: responseAcknowledgement }
							: result
					)
				if (
					!actual.success ||
					actual.data.acknowledgement.operation !== expected.operation ||
					(actual.data.acknowledgement.id !== expected.id &&
						expected.operation !== 'create') ||
					actual.data.acknowledgement.related_id !== expected.related_id ||
					(expected.operation === 'create' && !actual.data.acknowledgement.id)
				)
					transport.invalidResponse(
						'Administrative acknowledgement identity differs'
					)
				if (expected.operation === 'create') {
					const created = z
						.object({ data: z.object({ id: z.string().min(1) }) })
						.safeParse(result)
					if (
						!created.success ||
						created.data.data.id !== actual.data.acknowledgement.id
					)
						transport.invalidResponse(
							'Created acknowledgement identity differs'
						)
				}
			}
			const parsed = schema.safeParse(result)
			if (!parsed.success)
				transport.invalidResponse('Administrative response is invalid')
			return parsed.data
		} catch (error) {
			if (error instanceof AdminDomainWriteError) throw error
			if (!writing) throw transport.sanitizeError(error)
			if (!dispatched) throw new AdminDomainWriteError('subject', 401)
			if (
				error instanceof CinaTokenApiError &&
				error.code === 'http' &&
				[400, 401, 403, 404, 405, 409, 412, 413, 422, 428].includes(
					error.status
				)
			)
				throw new AdminDomainWriteError(
					'rejected',
					error.status,
					error.serverCode
				)
			throw new AdminDomainWriteError(
				'unknown',
				error instanceof CinaTokenApiError ? error.status : 0
			)
		}
	}
	return { send, verifyAdminDomainSubject, domain }
}
