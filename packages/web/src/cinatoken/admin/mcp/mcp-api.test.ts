/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { CinaTokenApiError, createCinaTokenCookieTransport } from '../../api'
import { adminDomainFixtureAuth } from '../domain-api-test-fixture'
import { AdminDomainWriteError } from '../domain-write-recovery'
import {
	createAdminMcpApi,
	type McpAdminTransport,
	type McpRequestOptions,
} from './mcp-api'
import { mcpServerSchema } from './mcp-contracts'
import { emptyMcpServerDraft, mcpServerDraftFrom } from './mcp-input'

const server = mcpServerSchema.parse({
	id: 'server-1',
	slug: 'deep-wiki',
	name: 'Docs',
	description: null,
	status: 'active',
	urlMasked: 'https://example.test/mcp?key=***',
	authHeaderNames: ['Authorization'],
	pricing: null,
	timeoutMs: 30_000,
	maxResponseBytes: 1_048_576,
	lastSyncedAt: null,
	lastSyncError: null,
})
const item = {
	id: 'item-1',
	serverId: server.id,
	kind: 'tool',
	upstreamKey: 'ask',
	exposedName: 'deep-wiki__ask',
	definition: {},
	pendingDefinition: null,
	reviewState: 'none',
	status: 'disabled',
	pricing: null,
}
const draft = {
	...emptyMcpServerDraft(),
	name: server.name,
	slug: server.slug,
	url: 'https://example.test/mcp',
}
const options: McpRequestOptions = {
	expectedConsoleSubject: 'fixture-subject',
	expectedUserId: 'fixture-user',
	onDispatch: () => {},
}
type Call = { path: string; init: RequestInit }
function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}
function fixture(
	reply: unknown | ((call: Call) => unknown | Promise<unknown>),
	authReply?: (path: string, original: unknown) => unknown
) {
	const calls: Call[] = []
	const cookie = createCinaTokenCookieTransport(async (input, init) => {
		const call = { path: String(input), init: init ?? {} }
		calls.push(call)
		const auth = adminDomainFixtureAuth(call.path)
		if (auth !== undefined)
			return json(authReply ? authReply(call.path, auth) : auth)
		const value = typeof reply === 'function' ? await reply(call) : reply
		return value instanceof Response ? value : json(value)
	})
	const transport: McpAdminTransport = {
		send: (path, schema, init, opts, reader) =>
			cookie.send(path, schema, init, opts, reader),
		invalidResponse: () => {
			throw new CinaTokenApiError('Invalid', 200, 'invalid-response')
		},
		sanitizeError: () => new Error('Safe error'),
	}
	return { api: createAdminMcpApi(transport), calls }
}
const isUnknown = (error: unknown) =>
	error instanceof AdminDomainWriteError && error.code === 'unknown'
const isSubject = (error: unknown) =>
	error instanceof AdminDomainWriteError && error.code === 'subject'

test('MCP list/detail enforce identities and project masked DTOs with nullable old pricing', async () => {
	const { api, calls } = fixture(({ path }: Call) =>
		path.endsWith('/server-1')
			? { success: true, data: { server, items: [item] } }
			: {
					success: true,
					data: [
						{
							...server,
							enabledCount: 1,
							pendingCount: 0,
							authHeaders: 'PRIVATE',
						},
					],
				}
	)
	const rows = await api.listMcpServers(options)
	assert.equal('authHeaders' in rows[0], false)
	assert.equal(
		(await api.getMcpServer(server.id, options)).items[0].serverId,
		server.id
	)
	assert.equal(calls[0].init.credentials, 'same-origin')
	assert.equal(calls[0].init.cache, 'no-store')
	assert.equal(
		new Headers(calls[0].init.headers).get(
			'X-CinaToken-Expected-Console-Subject'
		),
		'fixture-subject'
	)
	for (const data of [
		{ server: { ...server, id: 'foreign' }, items: [] },
		{ server, items: [{ ...item, serverId: 'foreign' }] },
		{ server, items: [item, item] },
	]) {
		const wrong = fixture({ success: true, data })
		await assert.rejects(
			wrong.api.getMcpServer(server.id),
			(error: unknown) =>
				error instanceof CinaTokenApiError && error.code === 'invalid-response'
		)
	}
	const duplicate = fixture({
		success: true,
		data: [
			{ ...server, enabledCount: 0, pendingCount: 0 },
			{ ...server, enabledCount: 0, pendingCount: 0 },
		],
	})
	await assert.rejects(duplicate.api.listMcpServers())
})
test('create and update perform fresh Console association checks and validate real MCP ACKs', async () => {
	const dispatched: string[] = []
	const { api, calls } = fixture(({ init }: Call) =>
		init.method === 'POST'
			? { success: true, data: { id: server.id, slug: server.slug } }
			: { success: true, data: { id: server.id } }
	)
	assert.deepEqual(
		await api.createMcpServer(draft, {
			...options,
			onDispatch: (operation) => dispatched.push(operation),
		}),
		{ id: server.id, slug: server.slug }
	)
	assert.deepEqual(
		calls.map((call) => call.path),
		['/api/auth/check', '/api/user/me', '/api/admin/mcp-servers']
	)
	const final = calls.at(-1)!
	assert.equal(
		new Headers(final.init.headers).get('X-CinaToken-Expected-Console-Subject'),
		'fixture-subject'
	)
	assert.equal(new Headers(final.init.headers).has('Authorization'), false)
	assert.deepEqual(dispatched, ['create'])
	await api.updateMcpServer(
		server.id,
		{ ...mcpServerDraftFrom(server), name: 'Renamed' },
		server,
		options
	)
	assert.deepEqual(JSON.parse(String(calls.at(-1)!.init.body)), {
		name: 'Renamed',
	})
	for (const reply of [
		{ success: true },
		{ success: true, data: { id: server.id, slug: 'foreign' } },
		{ success: false, message: 'PRIVATE' },
	])
		await assert.rejects(
			fixture(reply).api.createMcpServer(draft, options),
			isUnknown
		)
	await assert.rejects(
		fixture({ success: true, data: { id: 'foreign' } }).api.updateMcpServer(
			server.id,
			{ ...mcpServerDraftFrom(server), name: 'Renamed' },
			server,
			options
		),
		isUnknown
	)
})
test('wrong subjects, wrong portal association and missing recovery callback never dispatch a write', async () => {
	for (const auth of [
		(path: string, original: unknown) =>
			path === '/api/auth/check'
				? {
						authenticated: true,
						verification: 'verified',
						principalType: 'console',
						subject: 'other',
					}
				: original,
		(path: string, original: unknown) =>
			path === '/api/user/me'
				? {
						success: true,
						data: {
							userId: 'other',
							subject: 'fixture-subject',
							email: 'other@example.invalid',
							isAdmin: true,
							capabilities: [],
							organizations: [],
						},
					}
				: original,
	]) {
		const { api, calls } = fixture({}, auth)
		await assert.rejects(api.createMcpServer(draft, options), isSubject)
		assert.equal(
			calls.some((call) => call.path.startsWith('/api/admin/mcp')),
			false
		)
	}
	const missing = fixture({})
	await assert.rejects(
		missing.api.createMcpServer(draft, { ...options, onDispatch: undefined }),
		(error: unknown) =>
			error instanceof AdminDomainWriteError && error.code === 'storage'
	)
	assert.equal(missing.calls.length, 0)
})
test('MCP write loss, malformed success and cancellation after dispatch retain unknown outcome without retries', async () => {
	for (const reply of [
		() => {
			throw new TypeError('Network PRIVATE')
		},
		() => new Response('not-json'),
		{ success: true, data: { id: 'foreign' } },
	]) {
		const { api, calls } = fixture(reply)
		await assert.rejects(
			api.acceptMcpItemChange(server.id, item.id, options),
			isUnknown
		)
		assert.equal(
			calls.filter((call) => call.path.includes('/accept')).length,
			1
		)
	}
	const controller = new AbortController()
	const cancelled = fixture(() => {
		controller.abort()
		return { success: true, data: { id: item.id } }
	})
	await assert.rejects(
		cancelled.api.acceptMcpItemChange(server.id, item.id, {
			...options,
			signal: controller.signal,
		}),
		isUnknown
	)
})
test('invalid local inputs and pre-aborted operations never reach the service', async () => {
	const { api, calls } = fixture({})
	await assert.rejects(
		api.createMcpServer({ ...draft, url: 'javascript:PRIVATE' }, options)
	)
	await assert.rejects(
		api.setMcpItemStatus(server.id, [item.id, item.id], 'enabled', options)
	)
	await assert.rejects(
		api.updateMcpServer('foreign', mcpServerDraftFrom(server), server, options)
	)
	const controller = new AbortController()
	controller.abort()
	await assert.rejects(
		api.deleteMcpServer(server.id, { ...options, signal: controller.signal })
	)
	assert.equal(calls.length, 0)
})
test('item status, prices and acceptance require complete counts and matching item ACKs', async () => {
	const { api, calls } = fixture(({ path }: Call) =>
		path.endsWith('/status')
			? { success: true, data: { updated: 1 } }
			: { success: true, data: { id: item.id } }
	)
	assert.deepEqual(
		await api.setMcpItemStatus(server.id, [item.id], 'enabled', options),
		{ updated: 1 }
	)
	assert.deepEqual(JSON.parse(String(calls.at(-1)!.init.body)), {
		ids: [item.id],
		status: 'enabled',
	})
	const legacy = {
		v: 1 as const,
		unit: 'request',
		config: {},
		prices: { standard: 0, charged: 0.02, metered: 0.01 },
	}
	await api.setMcpItemPricing(server.id, item.id, legacy, options)
	assert.deepEqual(JSON.parse(String(calls.at(-1)!.init.body)), {
		pricing: legacy,
	})
	await api.setMcpItemPricing(server.id, item.id, null, options)
	assert.deepEqual(JSON.parse(String(calls.at(-1)!.init.body)), {
		pricing: null,
	})
	await api.acceptMcpItemChange(server.id, item.id, options)
	await assert.rejects(
		fixture({ success: true, data: { updated: 0 } }).api.setMcpItemStatus(
			server.id,
			[item.id],
			'enabled',
			options
		),
		isUnknown
	)
	await assert.rejects(
		fixture({ success: true, data: { id: 'foreign' } }).api.setMcpItemPricing(
			server.id,
			item.id,
			null,
			options
		),
		isUnknown
	)
})
test('delete uses the actual success-only ACK and rejects incomplete or unrelated payloads', async () => {
	const { api, calls } = fixture({ success: true })
	await api.deleteMcpServer(server.id, options)
	assert.equal(calls.at(-1)!.init.method, 'DELETE')
	for (const reply of [
		{},
		{ success: false },
		{ success: true, data: { id: 'foreign' } },
	])
		await assert.rejects(
			fixture(reply).api.deleteMcpServer(server.id, options),
			isUnknown
		)
})
test('test and sync preserve their different response contracts, with partial-sync failure unknown', async () => {
	const { api } = fixture(({ path }: Call) =>
		path.endsWith('/test')
			? {
					success: true,
					data: {
						ok: true,
						protocolVersion: '2025-06-18',
						serverInfo: { name: 'Docs' },
						counts: { tools: 2, prompts: 1, resources: 0 },
					},
				}
			: {
					success: true,
					data: { added: ['tool:ask'], changed: [], removed: [], unchanged: 1 },
				}
	)
	assert.equal((await api.testMcpServer(server.id, options)).counts.tools, 2)
	assert.deepEqual((await api.syncMcpServer(server.id, options)).added, [
		'tool:ask',
	])
	const failure = fixture(() =>
		json(
			{ success: false, message: 'https://PRIVATE.invalid/?key=SECRET' },
			400
		)
	)
	await assert.rejects(failure.api.syncMcpServer(server.id, options), isUnknown)
	await assert.rejects(
		failure.api.testMcpServer(server.id, options),
		(error: unknown) =>
			error instanceof AdminDomainWriteError &&
			error.code === 'rejected' &&
			!String(error).includes('PRIVATE')
	)
})
test('reveal verifies the live subject separately, returns secrets only on success, and never uses account scope', async () => {
	const { api, calls } = fixture({
		success: true,
		data: {
			url: 'https://example.test/?key=private',
			authHeaders: { Authorization: 'Bearer private' },
		},
	})
	const revealed = await api.revealMcpServer(server.id, options)
	assert.equal(revealed.authHeaders.Authorization, 'Bearer private')
	assert.deepEqual(
		calls.map((call) => call.path),
		[
			'/api/auth/check',
			'/api/user/me',
			'/api/admin/mcp-servers/server-1/reveal',
		]
	)
	assert.equal(
		new Headers(calls.at(-1)!.init.headers).get(
			'X-CinaToken-Expected-Console-Subject'
		),
		'fixture-subject'
	)
	assert.equal(
		new Headers(calls.at(-1)!.init.headers).has('X-CinaToken-Workspace'),
		false
	)
	await assert.rejects(fixture({}).api.revealMcpServer(server.id), isSubject)
})
test('read errors and rejected writes discard provider messages and arbitrary error codes', async () => {
	const { api } = fixture(() =>
		json(
			{ success: false, message: 'PRIVATE secret URL', code: 'PRIVATE_CODE' },
			403
		)
	)
	await assert.rejects(
		api.listMcpServers(),
		(error: unknown) =>
			error instanceof CinaTokenApiError &&
			error.status === 403 &&
			!String(error).includes('PRIVATE') &&
			error.serverCode === null
	)
	await assert.rejects(
		api.deleteMcpServer(server.id, options),
		(error: unknown) =>
			error instanceof AdminDomainWriteError &&
			error.code === 'rejected' &&
			error.serverCode === null &&
			!String(error).includes('PRIVATE')
	)
})
test('currency depends only on its independent read and cannot block mcp.read', async () => {
	for (const [billingCurrency, expected] of [
		[{ source: 'configured', value: 'CNY' }, 'CNY'],
		[{ source: 'missing', value: 'USD' }, 'USD'],
		[{ source: 'unsupported', value: 'EUR' }, null],
		[{ source: 'invalid', value: 'USD' }, null],
	] as const) {
		const { api } = fixture({ success: true, data: { billingCurrency } })
		assert.equal(await api.mcpCurrency(), expected)
	}
	const { api } = fixture(({ path }: Call) =>
		path.includes('/config/')
			? json({ success: false, message: 'PRIVATE' }, 403)
			: {
					success: true,
					data: [{ ...server, enabledCount: 0, pendingCount: 0 }],
				}
	)
	assert.equal(await api.mcpCurrency(), null)
	assert.equal((await api.listMcpServers()).length, 1)
})
test('oversized advertised MCP responses are cancelled and rejected before JSON materialization', async () => {
	let cancelled = false
	const body = new ReadableStream<Uint8Array>({
		cancel() {
			cancelled = true
		},
	})
	const { api } = fixture(
		() =>
			new Response(body, {
				headers: { 'Content-Length': String(16 * 1024 * 1024 + 1) },
			})
	)
	await assert.rejects(api.listMcpServers())
	assert.equal(cancelled, true)
})

test('MCP display projects only safe currency and timezone through a subject-bound read', async () => {
	const { api, calls } = fixture({
		success: true,
		data: {
			businessTimezone: { value: 'Asia/Shanghai', source: 'configured' },
			billingCurrency: { value: 'CNY', source: 'configured' },
			webhookSecret: 'PRIVATE_CONFIG',
			revision: 'private-revision',
		},
	})
	assert.deepEqual(await api.mcpDisplay(options), {
		timezone: 'Asia/Shanghai',
		timezoneSource: 'configured',
		currency: 'CNY',
		currencySource: 'configured',
	})
	assert.equal(calls.length, 1)
	assert.equal(calls[0].path, '/api/admin/config/overview')
	assert.equal(calls[0].init.method ?? 'GET', 'GET')
	assert.equal(
		new Headers(calls[0].init.headers).get(
			'X-CinaToken-Expected-Console-Subject'
		),
		'fixture-subject'
	)
	assert.equal(new Headers(calls[0].init.headers).get('Authorization'), null)
})

test('MCP display preserves currency independently of absent malformed or invalid timezone', async () => {
	for (const businessTimezone of [
		undefined,
		null,
		{ value: 'Invalid/Zone', source: 'configured' },
		{ value: 'Asia/Shanghai', source: 'missing' },
		{ value: 42, source: 'configured' },
	]) {
		const { api } = fixture({
			success: true,
			data: {
				businessTimezone,
				billingCurrency: { value: 'CNY', source: 'configured' },
			},
		})
		assert.deepEqual(await api.mcpDisplay(), {
			timezone: null,
			timezoneSource: null,
			currency: 'CNY',
			currencySource: 'configured',
		})
	}
})

test('MCP display accepts legacy and UTC fallback independently of unsupported currency', async () => {
	for (const [value, source] of [
		['Asia/Shanghai', 'legacy'],
		['UTC', 'missing'],
		['UTC', 'invalid'],
	] as const) {
		const { api } = fixture({
			success: true,
			data: {
				businessTimezone: { value, source },
				billingCurrency: { value: 'EUR', source: 'unsupported' },
			},
		})
		assert.deepEqual(await api.mcpDisplay(), {
			timezone: value,
			timezoneSource: source,
			currency: null,
			currencySource: null,
		})
	}
})

test('MCP display retains unauthorized forbidden and service error status without blocking MCP reads', async () => {
	for (const status of [401, 403, 503]) {
		const { api } = fixture(({ path }: Call) =>
			path === '/api/admin/config/overview'
				? json({ success: false, message: 'PRIVATE_CONFIG' }, status)
				: {
						success: true,
						data: [{ ...server, enabledCount: 0, pendingCount: 0 }],
					}
		)
		await assert.rejects(
			api.mcpDisplay(options),
			(error: unknown) =>
				error instanceof CinaTokenApiError &&
				error.status === status &&
				!String(error).includes('PRIVATE_CONFIG')
		)
		assert.equal((await api.listMcpServers(options)).length, 1)
	}
})

test('MCP display rejects invalid envelopes while accepting missing independent display fields', async () => {
	for (const reply of [
		{ success: false, data: {} },
		{ success: true, data: null },
		{ success: true },
	])
		await assert.rejects(fixture(reply).api.mcpDisplay())
	assert.deepEqual(
		await fixture({ success: true, data: {} }).api.mcpDisplay(),
		{
			timezone: null,
			timezoneSource: null,
			currency: null,
			currencySource: null,
		}
	)
})

test('MCP display rejects pre-aborted late and invalid-subject reads', async () => {
	const before = new AbortController()
	before.abort()
	const first = fixture({ success: true, data: {} })
	await assert.rejects(
		first.api.mcpDisplay({ ...options, signal: before.signal })
	)
	assert.equal(first.calls.length, 0)
	const after = new AbortController()
	const second = fixture(() => {
		after.abort()
		return {
			success: true,
			data: {
				businessTimezone: { value: 'Asia/Shanghai', source: 'configured' },
			},
		}
	})
	await assert.rejects(
		second.api.mcpDisplay({ ...options, signal: after.signal })
	)
	assert.equal(second.calls.length, 1)
	const third = fixture({ success: true, data: {} })
	await assert.rejects(
		third.api.mcpDisplay({ expectedConsoleSubject: ' invalid ' }),
		isSubject
	)
	assert.equal(third.calls.length, 0)
})
