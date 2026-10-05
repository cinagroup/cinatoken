/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
/** Business DTO regression fixtures also satisfy the fresh identity/ACK contract.
 * Dedicated domain-transport tests exercise missing/mismatched gates directly. */
export function adminDomainFixtureAuth(path: string): unknown | undefined {
	if (path === '/api/auth/check')
		return {
			authenticated: true,
			verification: 'verified',
			principalType: 'console',
			subject: 'fixture-subject',
		}
	if (path === '/api/user/me')
		return {
			success: true,
			data: {
				userId: 'fixture-user',
				subject: 'fixture-subject',
				email: 'fixture@example.test',
				isAdmin: true,
				capabilities: [],
				organizations: [],
			},
		}
	return undefined
}
export function adminDomainFixtureAck(
	path: string,
	init: RequestInit,
	body: unknown
): unknown {
	const method = (init.method ?? 'GET').toUpperCase()
	if (
		method === 'GET' ||
		method === 'HEAD' ||
		typeof body !== 'object' ||
		body === null ||
		Array.isArray(body)
	)
		return body
	const parts = path.split('?')[0]!.split('/').map(decodeURIComponent)
	const pathname = path.split('?')[0]!
	const domain = parts[3]
	let operation = method === 'POST' ? 'create' : 'update'
	if (method === 'DELETE') operation = 'delete'
	let id: string | undefined = parts[4]
	let related_id: string | undefined
	if (pathname.endsWith('/designate')) operation = 'designate'
	else if (
		domain === 'guardrails' &&
		method === 'PUT' &&
		parts[5] === 'assignments'
	) {
		operation = 'bind'
		const input = JSON.parse(String(init.body)) as { scope_id: string }
		related_id = input.scope_id
	} else if (
		domain === 'guardrails' &&
		method === 'DELETE' &&
		parts[4] === 'assignments'
	) {
		operation = 'unbind'
		id =
			new URL(path, 'https://fixture.invalid').searchParams.get(
				'expected_guardrail_id'
			) ?? undefined
		related_id = parts[6]
	} else if (pathname.endsWith('/import')) {
		operation = 'import'
		id = undefined
	} else if (path.endsWith('/bootstrap/deepseek')) {
		operation = 'bootstrap'
		id = undefined
	} else if (parts[5] === 'dashscope') {
		operation = 'resource'
		related_id = parts[6]
	} else if (domain === 'endpoints' && parts[5] === 'routes') {
		operation = method === 'DELETE' ? 'unlink' : 'link'
		related_id = parts[6]
	} else if (parts[4] === 'pools') {
		id = parts[5]
		operation = 'policy'
		if (path.endsWith('/sticky/reset')) operation = 'reset-sticky'
		else if (path.includes('/sticky/bindings/')) {
			operation = 'clear-sticky'
			related_id = parts[8]
		}
	} else if (
		operation === 'create' &&
		'data' in body &&
		typeof body.data === 'object' &&
		body.data !== null &&
		'id' in body.data &&
		typeof body.data.id === 'string'
	)
		id = body.data.id
	return { ...body, acknowledgement: { domain, operation, id, related_id } }
}
export function bindAdminDomainFixtureApi<T extends object>(
	api: T,
	methods: Record<string, number>
): T {
	const result = { ...api } as Record<string, unknown>
	for (const [name, index] of Object.entries(methods)) {
		const method = (api as Record<string, unknown>)[name]
		if (typeof method !== 'function') throw new Error('Unknown fixture method')
		result[name] = (...args: unknown[]) => {
			args[index] = {
				expectedConsoleSubject: 'fixture-subject',
				expectedUserId: 'fixture-user',
				onDispatch: () => undefined,
				...(typeof args[index] === 'object' && args[index] !== null
					? args[index]
					: {}),
			}
			return Reflect.apply(method, api, args) as unknown
		}
	}
	return result as T
}
