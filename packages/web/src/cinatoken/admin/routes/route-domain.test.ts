/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	buildRouteMutation,
	buildRoutePools,
	draftFromRoute,
	filterRoutePools,
	modelPolicyPatch,
	parseRouteSurfaces,
	validateRouteFilters,
	type RouteRow,
} from './route-domain'
import { routeTopologyRequiresVerification } from './route-options'

const row: RouteRow = {
	id: 'target-1',
	model_id: 'model-1',
	provider_id: 'provider-1',
	provider_model_name: 'upstream-1',
	model_name: 'Model One',
	provider_name: 'Provider One',
	priority: 10,
	weight: 3,
	status: 'active',
	route_group: 'default',
	price_override: JSON.stringify({
		charged_factor: 1.2,
		metered_factor: 0.7,
		retained: 'legal',
	}),
	custom_params: '{"temperature":0.2}',
	routing_metadata: null,
	upstream_protocol: 'openai',
	upstream_operation: 'chat',
	adapter: 'passthrough',
	route_pool_id: 'pool-1',
	pool_name: 'Chat',
	pool_strategy: 'weighted_random',
	pool_tier_strategies: '{"10":"weight_priority"}',
	pool_status: 'active',
	pool_sticky_enabled: 1,
	pool_sticky_idle_ttl_seconds: 7200,
	pool_sticky_epoch: 4,
	surfaces:
		'[{"id":"surface-1","request_protocol":"openai","request_operation":"chat","status":"active"}]',
}

test('route groups project the real pool and surface, without merging different targets', () => {
	const second = {
		...row,
		id: 'target-2',
		provider_id: 'provider-2',
		priority: 0,
	}
	const pools = buildRoutePools([second, row])
	assert.equal(pools.length, 1)
	assert.equal(pools[0]?.targets[0]?.id, 'target-1')
	assert.equal(pools[0]?.stickyEnabled, true)
	assert.equal(pools[0]?.surface.request_operation, 'chat')
	assert.equal(
		filterRoutePools(pools, {
			...validateRouteFilters(null),
			provider_id: 'provider-2',
		})[0]?.targets.length,
		1
	)
	assert.deepEqual(validateRouteFilters([]), {
		q: '',
		model: '',
		provider_id: '',
		status: 'all',
		route_group: '',
		kind: 'all',
		vendor: '',
		workspace: 'byModel',
		view: 'topology',
	})
	assert.equal(validateRouteFilters({ q: ' \u0000 Model\n ' }).q, 'Model')
})

test('URL aliases normalize to canonical fields without contradictory or duplicate filters', () => {
	const legacy = validateRouteFilters({
		provider: 'p1',
		group: 'premium',
		vendor: 'OpenAI',
		kind: 'image',
		workspace: 'overview',
	})
	assert.equal(legacy.provider_id, 'p1')
	assert.equal(legacy.route_group, 'premium')
	assert.equal(legacy.vendor, 'openai')
	assert.equal(legacy.kind, 'image')
	assert.equal(legacy.workspace, 'overview')
	assert.equal('provider' in legacy, false)
	assert.equal('group' in legacy, false)
	assert.equal(
		validateRouteFilters({ provider: 'p1', provider_id: 'p1' }).invalid,
		undefined
	)
	for (const raw of [
		{ provider: 'p1', provider_id: 'p2' },
		{ group: 'a', route_group: 'b' },
		{ status: ['active', 'inactive'] },
		{ q: ['a', 'b'] },
		{ provider_id: ['p1', 'p1'] },
		{ kind: 'invalid' },
		{ view: 'invalid' },
		{ workspace: 'invalid' },
		{ invalid: 'forged' },
		{ invalid: false },
	])
		assert.equal(validateRouteFilters(raw).invalid, true)
	assert.equal(validateRouteFilters({ ...legacy, invalid: true }).invalid, true)
})

test('editing only priority does not move a target or rewrite retained pricing/custom fields', () => {
	const draft = { ...draftFromRoute(row), priority: '11' }
	assert.deepEqual(buildRouteMutation(draft, row), { priority: 11 })
})

test('existing non-topology fields stay manageable with unknown provider capability, new/clone/moves require verification', () => {
	const draft = draftFromRoute(row)
	assert.equal(
		routeTopologyRequiresVerification(
			{
				...draft,
				priority: '20',
				weight: '4',
				chargedFactor: '2',
				customParams: '{"temperature":0.4}',
			},
			row
		),
		false
	)
	assert.equal(routeTopologyRequiresVerification(draft, null), true)
	assert.equal(routeTopologyRequiresVerification(draft, row, true), true)
	for (const patch of [
		{ group: 'premium' },
		{ providerId: 'provider-2' },
		{ providerModelName: 'other' },
		{ requestOperation: 'responses' },
	])
		assert.equal(
			routeTopologyRequiresVerification({ ...draft, ...patch }, row),
			true
		)
})

test('topology change includes exact request surface and a compatible adapter', () => {
	const draft = { ...draftFromRoute(row), group: 'premium' }
	assert.deepEqual(buildRouteMutation(draft, row), {
		route_group: 'premium',
		request_protocol: 'openai',
		request_operation: 'chat',
		upstream_protocol: 'openai',
		upstream_operation: 'chat',
		adapter: 'passthrough',
	})
	assert.throws(
		() =>
			buildRouteMutation(
				{ ...draft, adapter: 'dashscope-asr-file-async' },
				row
			),
		/adapter/
	)
})

test('ambiguous old surface cannot be guessed during a topology edit', () => {
	const old = { ...row, surfaces: null }
	assert.equal(parseRouteSurfaces(old)[0]?.status, 'unknown')
	assert.throws(
		() => buildRouteMutation({ ...draftFromRoute(old), group: 'premium' }, old),
		/ambiguous/
	)
	assert.deepEqual(
		buildRouteMutation({ ...draftFromRoute(old), weight: '4' }, old),
		{ weight: 4 }
	)
})

test('target choices must belong to verified model and provider catalogs', () => {
	const draft = draftFromRoute(row)
	assert.throws(
		() =>
			buildRouteMutation({ ...draft, providerId: 'provider-2' }, row, {
				modelIds: ['model-1'],
				providerIds: ['provider-1'],
			}),
		/verified catalog/
	)
})

test('price schedule edit normalizes legacy multiplier while retaining other legal fields', () => {
	const legacy = {
		...row,
		price_override: JSON.stringify({
			charged_factor: 2,
			metered_factor: 1,
			retained: 'legal',
			schedule: {
				mode: 'multiply',
				charged: [{ start: '09:00', end: '12:00', factor: 1.5 }],
				metered: [],
			},
		}),
	}
	const draft = draftFromRoute(legacy)
	assert.equal(draft.schedule[0]?.chargedFactor, '3')
	const changed = { ...draft, chargedFactor: '2.5' }
	const patch = buildRouteMutation(changed, legacy)
	const pricing = JSON.parse(String(patch.price_override)) as Record<
		string,
		unknown
	>
	assert.equal(pricing.retained, 'legal')
	assert.equal(pricing.charged_factor, 2.5)
	assert.equal((pricing.schedule as { mode: string }).mode, 'override')
})

test('overlapping periods and invalid weekday or factor cannot be written', () => {
	const base = draftFromRoute(row)
	assert.throws(
		() => buildRouteMutation({ ...base, priority: '' }, row),
		/priority/
	)
	const a = {
		start: '09:00',
		end: '12:00',
		days: [1],
		chargedFactor: '1',
		meteredFactor: '1',
	}
	const b = { ...a, start: '11:00' }
	assert.throws(
		() => buildRouteMutation({ ...base, schedule: [a, b] }, row),
		/schedule/
	)
	assert.throws(
		() => buildRouteMutation({ ...base, schedule: [{ ...a, days: [9] }] }, row),
		/weekdays/
	)
	assert.throws(
		() => buildRouteMutation({ ...base, chargedFactor: '-1' }, row),
		/chargedFactor/
	)
})

test('model rule edit preserves unrelated rules and refuses malformed stored policy', () => {
	const current = JSON.stringify({
		strategy: 'weighted_random',
		rules: {
			'openai.chat:default': { strategy: 'hash_affinity' },
			'anthropic:premium': { strategy: 'weight_priority' },
		},
	})
	const next = modelPolicyPatch(
		current,
		{ protocol: 'openai', operation: 'chat', group: 'default' },
		'weighted_round_robin'
	)
	assert.deepEqual(JSON.parse(next ?? ''), {
		strategy: 'weighted_random',
		rules: {
			'openai.chat:default': { strategy: 'weighted_round_robin' },
			'anthropic:premium': { strategy: 'weight_priority' },
		},
	})
	assert.throws(
		() =>
			modelPolicyPatch(
				'{broken',
				{ protocol: 'openai', operation: 'chat', group: 'default' },
				null
			),
		/invalid/
	)
})
