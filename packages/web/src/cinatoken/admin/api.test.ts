import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CinaTokenApiError } from '../api'
import { createCinaTokenAdminApi } from './api'
import { validateAuditLogSearch } from './audit-logs/audit-log-domain'
import { adminDomainFixtureAuth } from './domain-api-test-fixture'
import { AdminDomainWriteError } from './domain-write-recovery'

const writeOptions = {
	expectedConsoleSubject: 'fixture-subject',
	expectedUserId: 'fixture-user',
	onDispatch: () => undefined,
}

const provider = {
	id: 'p1',
	name: 'Provider',
	vendor_key: 'openai',
	icon_key: 'openai',
	endpoints: '{"openai":{"base":"https://example.test/v1"}}',
	api_key: 'abc…7890',
	status: 'active',
	description: null,
	shared_channel_type: null,
	created_at: '2026-09-27T00:00:00.000Z',
	has_pending_key: false,
	routes_count: 1,
	active_routes_count: 1,
}

const model = {
	id: 'vendor/model',
	display_name: 'Model',
	vendor: 'vendor',
	context_window: 65_536,
	max_tokens: 8192,
	pricing_profile: null,
	input_modalities: '["text"]',
	output_modalities: '["text"]',
	released_at: null,
	description: null,
	metadata: null,
	route_policy: null,
	created_at: '2026-09-27T00:00:00.000Z',
	routes_count: 1,
	active_routes_count: 1,
	tags: [],
}

function fake(
	run: (url: string, init: RequestInit) => Promise<Response>
): typeof fetch {
	return (async (url: RequestInfo | URL, init?: RequestInit) => {
		const auth = adminDomainFixtureAuth(String(url))
		if (auth !== undefined) return Response.json(auth)
		return run(String(url), init ?? {})
	}) as typeof fetch
}

test('admin requests use same-origin Cookie and never inherit a workspace or Bearer credential', async () => {
	const api = createCinaTokenAdminApi(
		fake(async (url, init) => {
			assert.equal(url, '/api/admin/providers')
			assert.equal(init.credentials, 'same-origin')
			assert.equal(init.cache, 'no-store')
			const headers = new Headers(init.headers)
			assert.equal(headers.get('Accept'), 'application/json')
			assert.equal(headers.get('Authorization'), null)
			assert.equal(headers.get('X-CinaToken-Workspace'), null)
			return Response.json({ success: true, data: [provider], count: 1 })
		})
	)
	const accountOptions = { expectedWorkspaceId: 'another-workspace' }
	const rows = await api.providerList({ ...accountOptions, timeoutMs: 1_000 })
	assert.equal(rows[0].id, 'p1')
})

test('Admin API factory forwards the CSV response reader for a full-filter audit export', async () => {
	const csv =
		'\uFEFFaudit_id,created_at_utc,user_email\r\naudit-1,2026-09-29T03:00:00.000Z,x@example.test\r\n'
	const api = createCinaTokenAdminApi(
		fake(async (url, init) => {
			const parsed = new URL(url, 'https://example.test')
			assert.equal(parsed.pathname, '/api/admin/budget-audit-logs/export.csv')
			assert.equal(parsed.searchParams.get('user_email'), 'x@example.test')
			assert.equal(parsed.searchParams.has('page'), false)
			assert.equal(init.credentials, 'same-origin')
			assert.equal(init.cache, 'no-store')
			assert.equal(new Headers(init.headers).get('Accept'), 'text/csv')
			return new Response(csv, {
				headers: { 'Content-Type': 'text/csv; charset=utf-8' },
			})
		})
	)
	const search = validateAuditLogSearch({
		page: 4,
		user_email: 'x@example.test',
	})
	const blob = await api.exportAuditLogs(search)
	assert.deepEqual(
		new Uint8Array(await blob.arrayBuffer()),
		new TextEncoder().encode(csv)
	)
})

test('Models factory uses the Console Cookie transport without portal workspace or inherited credential', async () => {
	const api = createCinaTokenAdminApi(
		fake(async (url, init) => {
			assert.equal(url, '/api/admin/models')
			assert.equal(init.credentials, 'same-origin')
			assert.equal(init.cache, 'no-store')
			const headers = new Headers(init.headers)
			assert.equal(headers.get('Authorization'), null)
			assert.equal(headers.get('X-CinaToken-Workspace'), null)
			return Response.json({
				success: true,
				data: [model],
				count: 1,
				billing_currency: 'USD',
			})
		})
	)
	const portalOptions = {
		expectedWorkspaceId: 'untrusted-workspace',
		timeoutMs: 1_000,
	}
	const rows = await api.modelList(portalOptions)
	assert.equal(rows[0].id, model.id)
})

test('Endpoints factory preserves denied Console status without leaking response details', async () => {
	const api = createCinaTokenAdminApi(
		fake(async (url, init) => {
			assert.equal(url, '/api/admin/endpoints')
			assert.equal(init.credentials, 'same-origin')
			assert.equal(new Headers(init.headers).get('Authorization'), null)
			return Response.json(
				{ success: false, message: 'private-endpoint-context' },
				{ status: 403 }
			)
		})
	)
	await assert.rejects(api.endpointList(), (error: unknown) => {
		assert.ok(error instanceof CinaTokenApiError)
		assert.equal(error.status, 403)
		assert.equal(error.message.includes('private-endpoint-context'), false)
		return true
	})
})

test('Routes factory uses the Console Cookie transport and preserves denied status', async () => {
	const api = createCinaTokenAdminApi(
		fake(async (url, init) => {
			assert.equal(url, '/api/admin/routes')
			assert.equal(init.credentials, 'same-origin')
			assert.equal(init.cache, 'no-store')
			const headers = new Headers(init.headers)
			assert.equal(headers.get('Authorization'), null)
			assert.equal(headers.get('X-CinaToken-Workspace'), null)
			return Response.json(
				{ success: false, message: 'private-route-context' },
				{ status: 403 }
			)
		})
	)
	await assert.rejects(api.routeList(), (error: unknown) => {
		assert.ok(error instanceof CinaTokenApiError)
		assert.equal(error.status, 403)
		assert.equal(error.message.includes('private-route-context'), false)
		return true
	})
})

test('Data Policies factory uses Console Cookie transport and preserves denied status', async () => {
	const api = createCinaTokenAdminApi(
		fake(async (url, init) => {
			assert.equal(url, '/api/admin/data-policies')
			assert.equal(init.credentials, 'same-origin')
			assert.equal(init.cache, 'no-store')
			const headers = new Headers(init.headers)
			assert.equal(headers.get('Authorization'), null)
			assert.equal(headers.get('X-CinaToken-Workspace'), null)
			return Response.json(
				{ success: false, message: 'private-policy-context' },
				{ status: 403 }
			)
		})
	)
	await assert.rejects(api.dataPolicyList(), (error: unknown) => {
		assert.ok(error instanceof CinaTokenApiError)
		assert.equal(error.status, 403)
		assert.equal(error.message.includes('private-policy-context'), false)
		return true
	})
})

test('admin writes retain HTTP conflict and permission states without exposing server error text or retrying', async () => {
	for (const status of [401, 403, 409, 429, 503]) {
		let requests = 0
		const api = createCinaTokenAdminApi(
			fake(async (_url, init) => {
				requests += 1
				assert.equal(init.method, 'PATCH')
				return Response.json(
					{ success: false, message: 'credential-private-database-details' },
					{ status }
				)
			})
		)
		await assert.rejects(
			api.updateProvider('p1', { name: 'Updated' }, writeOptions),
			(error: unknown) => {
				assert.ok(error instanceof AdminDomainWriteError)
				assert.equal(error.status, status)
				assert.equal(
					error.code,
					status === 429 || status >= 500 ? 'unknown' : 'rejected'
				)
				assert.equal(error.message.includes('credential-private'), false)
				return true
			}
		)
		assert.equal(requests, 1)
	}
})

test('admin rejects invalid JSON and malformed successful responses without retaining response details', async () => {
	for (const reply of [
		new Response('private-invalid-json', {
			headers: { 'Content-Type': 'application/json' },
		}),
		Response.json({
			success: true,
			data: [{ ...provider, api_key: 'private-unmasked-secret' }],
			count: 1,
		}),
	]) {
		const api = createCinaTokenAdminApi(fake(async () => reply))
		await assert.rejects(api.providerList(), (error: unknown) => {
			assert.ok(error instanceof CinaTokenApiError)
			assert.equal(error.code, 'invalid-response')
			assert.equal(error.message.includes('private'), false)
			return true
		})
	}
})

test('admin rejected business success cannot become a fulfilled mutation', async () => {
	const api = createCinaTokenAdminApi(
		fake(async () => Response.json({ success: false, message: 'private-key' }))
	)
	await assert.rejects(
		api.deleteProvider('p1', writeOptions),
		(error: unknown) => {
			assert.ok(error instanceof AdminDomainWriteError)
			assert.equal(error.code, 'unknown')
			assert.equal(error.status, 200)
			assert.equal(error.message.includes('private-key'), false)
			return true
		}
	)
})

test('admin ignores late successful data after cancellation even when fetch ignores AbortSignal', async () => {
	const abort = new AbortController()
	let resolve!: (response: Response) => void
	const api = createCinaTokenAdminApi(
		fake(async (_url, init) => {
			assert.ok(init.signal)
			return new Promise<Response>((done) => {
				resolve = done
			})
		})
	)
	const pending = api.providerList({ signal: abort.signal })
	abort.abort()
	resolve(Response.json({ success: true, data: [provider], count: 1 }))
	await assert.rejects(
		pending,
		(error: unknown) =>
			error instanceof CinaTokenApiError && error.code === 'cancelled'
	)
})

test('admin times out a late response and preserves a safe error classification', async () => {
	const api = createCinaTokenAdminApi(
		fake(async () => {
			await new Promise((done) => setTimeout(done, 20))
			return Response.json({ success: true, data: [provider], count: 1 })
		})
	)
	await assert.rejects(
		api.providerList({ timeoutMs: 1 }),
		(error: unknown) =>
			error instanceof CinaTokenApiError && error.code === 'timeout'
	)
})

test('native resource responses preserve valid upstream JSON rather than requiring an envelope', async () => {
	const api = createCinaTokenAdminApi(
		fake(async (url, init) => {
			assert.equal(url, '/api/admin/providers/p1/dashscope/voices')
			assert.equal(init.method, 'POST')
			return Response.json(
				{
					request_id: 'request-1',
					output: { voices: [{ voice: 'voice-1' }] },
				},
				{
					headers: {
						'X-CinaToken-Acknowledgement': JSON.stringify({
							domain: 'providers',
							operation: 'resource',
							id: 'p1',
							related_id: 'voices',
						}),
					},
				}
			)
		})
	)
	const result = await api.manageProviderDashScope(
		'p1',
		'voices',
		{
			action: 'list',
			page_size: 10,
		},
		writeOptions
	)
	assert.deepEqual(result.body, {
		request_id: 'request-1',
		output: { voices: [{ voice: 'voice-1' }] },
	})
	assert.deepEqual(result.redactedPaths, [])
})
