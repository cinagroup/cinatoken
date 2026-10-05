/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CinaTokenApiError, createCinaTokenCookieTransport } from '../../api'
import {
	adminDomainFixtureAuth,
	adminDomainFixtureAck,
	bindAdminDomainFixtureApi,
} from '../domain-api-test-fixture'
import { AdminDomainWriteError } from '../domain-write-recovery'
import { createRoutesApi } from './routes-api'
import {
	createRouteInputSchema,
	routePriceOverrideSchema,
	routePoolPolicyPatchSchema,
	updateRouteInputSchema,
} from './routes-contracts'

const base = {
	id: 'route/one',
	model_id: 'vendor/model',
	provider_id: 'provider/one',
	provider_model_name: 'model-one',
	priority: 10,
	weight: 2,
	status: 'active',
	route_group: 'default',
	price_override: '{"charged_factor":1,"metered_factor":0.5}',
	custom_params: null,
	routing_metadata: null,
	upstream_protocol: 'openai',
	upstream_operation: 'chat',
	adapter: 'passthrough',
	route_pool_id: 'pool/one',
}
const joined = {
	...base,
	surfaces:
		'[{"id":"surface/one","request_protocol":"openai","request_operation":"chat","status":"active"}]',
	pool_name: 'OpenAI chat',
	pool_strategy: null,
	pool_tier_strategies: null,
	pool_status: 'active',
	pool_sticky_enabled: 1,
	pool_sticky_idle_ttl_seconds: 3600,
	pool_sticky_epoch: 4,
	model_name: 'Model One',
	provider_name: 'Provider One',
	provider_status: 'active',
}
type Call = { path: string; init: RequestInit }
function fixture(reply: (call: Call) => Promise<Response>) {
	const calls: Call[] = []
	const request: typeof fetch = async (input, init) => {
		const call = { path: String(input), init: init ?? {} }
		const auth = adminDomainFixtureAuth(call.path)
		if (auth !== undefined) return Response.json(auth)
		calls.push(call)
		const response = await reply(call)
		if ((call.init.method ?? 'GET') === 'GET' || !response.ok) return response
		try {
			return Response.json(
				adminDomainFixtureAck(
					call.path,
					call.init,
					await response.clone().json()
				),
				{ status: response.status, headers: response.headers }
			)
		} catch {
			return response
		}
	}
	const transport = createCinaTokenCookieTransport(request)
	const api = createRoutesApi({
		send(path, schema, init, options) {
			return transport.send(path, schema, init, options)
		},
		invalidResponse() {
			throw new CinaTokenApiError(
				'Invalid route response',
				200,
				'invalid-response'
			)
		},
		sanitizeError(error) {
			if (error instanceof CinaTokenApiError)
				return new CinaTokenApiError(
					'Route operation failed',
					error.status,
					error.code
				)
			return new Error('Route operation failed')
		},
	})
	return {
		api: bindAdminDomainFixtureApi(api, {
			createRoute: 1,
			updateRoute: 2,
			deleteRoute: 1,
			patchRoutePoolPolicy: 2,
			clearStickyBinding: 2,
			resetStickyBindings: 1,
		}),
		calls,
	}
}
const ok = (data: unknown): Promise<Response> =>
	Promise.resolve(Response.json({ success: true, data }))
const invalid = (error: unknown): boolean =>
	(error instanceof CinaTokenApiError && error.code === 'invalid-response') ||
	(error instanceof AdminDomainWriteError && error.code === 'unknown')

test('route list is same-origin Cookie only, validates filters/count and projects JOIN fields', async () => {
	const { api, calls } = fixture(() =>
		ok([{ ...joined, provider_api_key: 'PRIVATE' }]).then(async (response) =>
			Response.json({ ...(await response.json()), count: 1 })
		)
	)
	const routes = await api.routeList(
		{ model_id: base.model_id, provider_id: base.provider_id },
		{ timeoutMs: 500, expectedWorkspaceId: 'PRIVATE' } as never
	)
	assert.equal(routes.length, 1)
	assert.equal(routes[0]!.route_pool_id, 'pool/one')
	assert.equal(JSON.stringify(routes).includes('PRIVATE'), false)
	assert.equal(
		calls[0]!.path,
		'/api/admin/routes?model_id=vendor%2Fmodel&provider_id=provider%2Fone'
	)
	assert.equal(calls[0]!.init.credentials, 'same-origin')
	assert.equal(calls[0]!.init.cache, 'no-store')
	const headers = new Headers(calls[0]!.init.headers)
	for (const name of ['Authorization', 'New-Api-User', 'X-CinaToken-Workspace'])
		assert.equal(headers.get(name), null)
	assert.equal(headers.get('Accept'), 'application/json')
	for (const body of [
		{ success: true, data: [joined], count: 0 },
		{ success: true, data: [joined, joined], count: 2 },
		{ success: true, data: [{ ...joined, model_id: 'other' }], count: 1 },
	]) {
		await assert.rejects(
			fixture(async () => Response.json(body)).api.routeList({
				model_id: base.model_id,
			}),
			invalid
		)
	}
})

test('detail accepts table projection without JOIN fields and rejects another route', async () => {
	const { api } = fixture(() =>
		ok({ ...base, created_at: '2026-09-28T00:00:00Z' })
	)
	const detail = await api.route(base.id)
	assert.equal(detail.id, base.id)
	assert.equal('pool_name' in detail, false)
	await assert.rejects(
		fixture(() => ok({ ...base, id: 'route/other' })).api.route(base.id),
		invalid
	)
})

test('route context uses exact dual-gated metadata endpoint and preserves configured EUR/IANA timezone', async () => {
	const { api, calls } = fixture(() =>
		ok({
			global_route_strategy: 'hash_affinity',
			billing_currency: 'EUR',
			business_timezone: 'Asia/Singapore',
			private_config: 'PRIVATE',
		})
	)
	const context = await api.routeContext()
	assert.deepEqual(context, {
		global_route_strategy: 'hash_affinity',
		billing_currency: 'EUR',
		business_timezone: 'Asia/Singapore',
	})
	assert.equal(calls[0]!.path, '/api/admin/routes/context')
	for (const data of [
		{
			global_route_strategy: 'unknown',
			billing_currency: 'USD',
			business_timezone: 'UTC',
		},
		{ global_route_strategy: 'hash_affinity', billing_currency: 'EUR' },
		{
			global_route_strategy: 'hash_affinity',
			billing_currency: 'EUR',
			business_timezone: 'bad/timezone',
		},
	])
		await assert.rejects(fixture(() => ok(data)).api.routeContext(), invalid)
	await assert.rejects(
		fixture(async () =>
			Response.json(
				{ success: false, message: 'private config' },
				{ status: 403 }
			)
		).api.routeContext(),
		(error) => error instanceof CinaTokenApiError && error.status === 403
	)
})

test('create carries only canonical route fields and validates new-row identity', async () => {
	const { api, calls } = fixture(() => ok({ id: base.id }))
	const created = await api.createRoute({
		model_id: base.model_id,
		provider_id: base.provider_id,
		provider_model_name: base.provider_model_name,
		price_override: '{"charged_factor":1,"metered_factor":0.5}',
		custom_params: '{"temperature":0.5}',
		request_protocol: 'openai',
		request_operation: 'chat',
		upstream_protocol: 'openai',
		upstream_operation: 'chat',
	})
	assert.deepEqual(created, { id: base.id })
	assert.equal(calls[0]!.path, '/api/admin/routes')
	assert.equal(calls[0]!.init.method, 'POST')
	assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
		model_id: base.model_id,
		provider_id: base.provider_id,
		provider_model_name: base.provider_model_name,
		price_override: { charged_factor: 1, metered_factor: 0.5 },
		custom_params: '{"temperature":0.5}',
		request_protocol: 'openai',
		request_operation: 'chat',
		upstream_protocol: 'openai',
		upstream_operation: 'chat',
	})
	assert.throws(() =>
		createRouteInputSchema.parse({
			model_id: base.model_id,
			provider_id: base.provider_id,
			provider_model_name: base.provider_model_name,
			api_key: 'PRIVATE',
		})
	)
	assert.deepEqual(
		createRouteInputSchema.parse({
			model_id: base.model_id,
			provider_id: base.provider_id,
			provider_model_name: base.provider_model_name,
			price_override:
				'{"charged_factor":1.5,"metered_factor":0.8,"retained":{"note":"legacy-safe"},"charged":{"tiers":[]}}',
		}).price_override,
		{
			charged_factor: 1.5,
			metered_factor: 0.8,
			retained: { note: 'legacy-safe' },
		}
	)
	assert.throws(() => routePriceOverrideSchema.parse({ charged_factor: -1 }))
	assert.throws(() =>
		createRouteInputSchema.parse({
			model_id: base.model_id,
			provider_id: base.provider_id,
			provider_model_name: base.provider_model_name,
			price_override: '{"charged_factor":1,"user":100}',
		})
	)
	assert.deepEqual(
		await fixture(() =>
			ok({ id: base.id, api_key: 'PRIVATE' })
		).api.createRoute({
			model_id: base.model_id,
			provider_id: base.provider_id,
			provider_model_name: base.provider_model_name,
		}),
		{ id: base.id }
	)
})

test('status-only update preserves partial PATCH and topology requires explicit surface', async () => {
	const { api, calls } = fixture(async () => Response.json({ success: true }))
	await api.updateRoute(base.id, { status: 'inactive' })
	assert.equal(calls[0]!.path, '/api/admin/routes/route%2Fone')
	assert.equal(calls[0]!.init.method, 'PATCH')
	assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
		status: 'inactive',
	})
	assert.throws(() => updateRouteInputSchema.parse({}))
	assert.throws(() => updateRouteInputSchema.parse({ route_group: 'new' }))
	assert.throws(() =>
		updateRouteInputSchema.parse({ model_id: 'another-model' })
	)
	assert.doesNotThrow(() =>
		updateRouteInputSchema.parse({
			route_group: 'new',
			request_protocol: 'openai',
			request_operation: 'chat',
		})
	)
	assert.throws(() => updateRouteInputSchema.parse({ route_pool_id: 'other' }))
	await api.deleteRoute(base.id)
	assert.equal(calls[1]!.init.method, 'DELETE')
})

test('pool policy, sticky summary/lookup/clear/reset use exact paths and typed outcomes', async () => {
	const hash = 'a'.repeat(64)
	const { api, calls } = fixture(async (call) => {
		if (call.path.endsWith('/summary'))
			return Response.json({
				success: true,
				data: {
					total_active: 3,
					stale_count: 1,
					targets: [
						{
							route_target_id: base.id,
							active_count: 3,
							share: 1,
							last_updated_at: null,
						},
					],
				},
			})
		if (call.path.includes('/lookup?'))
			return Response.json({
				success: true,
				data: {
					user_id: 'user/one',
					affinity_hash: hash,
					affinity_key: 'private-key',
					binding: {
						route_target_id: base.id,
						expires_at: '2026-09-29T00:00:00Z',
						pool_epoch: 4,
						remaining_seconds: 300,
						epoch_valid: true,
						expired: false,
					},
				},
			})
		if (call.init.method === 'DELETE')
			return Response.json({ success: true, data: { cleared: false } })
		if (call.path.endsWith('/reset'))
			return Response.json({ success: true, data: { sticky_epoch: 5 } })
		return Response.json({ success: true })
	})
	await api.patchRoutePoolPolicy('pool/one', {
		strategy: 'weight_priority',
		tier_strategies: { '10': 'hash_affinity' },
		sticky_routing: { enabled: true, idle_ttl_seconds: 3600 },
	})
	assert.equal(calls[0]!.path, '/api/admin/routes/pools/pool%2Fone')
	assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
		strategy: 'weight_priority',
		tier_strategies: { '10': 'hash_affinity' },
		sticky_routing: { enabled: true, idle_ttl_seconds: 3600 },
	})
	assert.equal((await api.stickyBindingsSummary('pool/one')).total_active, 3)
	const lookup = await api.lookupStickyBinding('pool/one', {
		model_id: base.model_id,
		route_group: 'default',
		protocol: 'openai',
		request_operation: 'chat',
		user_id: 'user/one',
	})
	assert.equal(lookup.binding?.route_target_id, base.id)
	assert.equal(
		calls[2]!.path,
		'/api/admin/routes/pools/pool%2Fone/sticky/bindings/lookup?model_id=vendor%2Fmodel&route_group=default&protocol=openai&request_operation=chat&user_id=user%2Fone'
	)
	assert.deepEqual(await api.clearStickyBinding('pool/one', hash), {
		cleared: false,
	})
	assert.deepEqual(await api.resetStickyBindings('pool/one'), {
		sticky_epoch: 5,
	})
	assert.throws(() => routePoolPolicyPatchSchema.parse({}))
	assert.throws(() =>
		routePoolPolicyPatchSchema.parse({
			sticky_routing: { enabled: true, idle_ttl_seconds: 1 },
		})
	)
	assert.deepEqual(
		routePoolPolicyPatchSchema.parse({
			tier_strategies: '{"10":"weight_priority"}',
		}),
		{
			tier_strategies: { '10': 'weight_priority' },
		}
	)
	assert.deepEqual(routePoolPolicyPatchSchema.parse({ tier_strategies: '' }), {
		tier_strategies: null,
	})
	assert.throws(() =>
		routePoolPolicyPatchSchema.parse({
			tier_strategies: '{"bad":"weight_priority"}',
		})
	)
	await assert.rejects(api.clearStickyBinding('pool/one', 'wrong'))
	await assert.rejects(
		api.lookupStickyBinding('pool/one', {
			model_id: base.model_id,
			protocol: 'openai',
		})
	)
})

test('401/403 and malformed sticky responses fail closed without leaking server messages', async () => {
	for (const status of [401, 403]) {
		const { api } = fixture(async () =>
			Response.json(
				{
					success: false,
					message: 'private server detail',
				},
				{ status }
			)
		)
		await assert.rejects(
			api.routeList(),
			(error) =>
				(error instanceof CinaTokenApiError ||
					error instanceof AdminDomainWriteError) &&
				error.status === status &&
				!error.message.includes('private server detail')
		)
	}
	const { api } = fixture(() =>
		ok({
			total_active: 1,
			stale_count: 0,
			targets: [
				{
					route_target_id: base.id,
					active_count: 1,
					share: 2,
					last_updated_at: null,
				},
			],
		})
	)
	await assert.rejects(api.stickyBindingsSummary('pool/one'), invalid)
})
