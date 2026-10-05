/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { adminModelSchema } from '../model-contracts'
import {
	buildRoutePools,
	validateRouteFilters,
	type RouteRow,
} from './route-domain'
import {
	buildRouteWorkspace,
	effectiveRouteStrategy,
	groupPriorityTargets,
	routePriceSummary,
} from './route-workspace-domain'

const model = adminModelSchema.parse({
	id: 'model',
	display_name: 'Example',
	vendor: 'OpenAI',
	context_window: 8192,
	max_tokens: 2048,
	pricing_profile: null,
	input_modalities: '["text"]',
	output_modalities: '["text"]',
	released_at: null,
	description: null,
	metadata: null,
	route_policy: JSON.stringify({
		strategy: 'weighted_random',
		rules: {
			'openai.chat:default': { strategy: 'hash_affinity' },
			'openai:default': { strategy: 'weighted_round_robin' },
		},
	}),
	created_at: '2026-10-01T00:00:00Z',
	routes_count: 1,
	active_routes_count: 1,
	tags: [],
})
const row: RouteRow = {
	id: 'target',
	model_id: 'model',
	provider_id: 'provider',
	provider_model_name: 'upstream',
	model_name: 'Example',
	provider_name: 'Provider',
	priority: 10,
	weight: 1,
	status: 'active',
	route_group: 'default',
	price_override: null,
	custom_params: null,
	routing_metadata: null,
	upstream_protocol: 'openai',
	upstream_operation: 'chat',
	adapter: 'passthrough',
	route_pool_id: 'pool',
	pool_name: 'Pool',
	pool_strategy: null,
	pool_tier_strategies: null,
	pool_status: 'active',
	pool_sticky_enabled: true,
	pool_sticky_idle_ttl_seconds: 3600,
	pool_sticky_epoch: 0,
	surfaces:
		'[{"id":"surface","request_protocol":"openai","request_operation":"chat","status":"active"}]',
}
const pool = buildRoutePools([row])[0]!

test('unrouted models remain visible for model/kind/vendor/search but disappear for target-specific filters', () => {
	const unrouted = {
		...model,
		id: 'unrouted',
		routes_count: 0,
		active_routes_count: 0,
	}
	assert.deepEqual(
		buildRouteWorkspace(
			[model, unrouted],
			[pool],
			validateRouteFilters({ vendor: 'openai' })
		).map((group) => group.id),
		['model', 'unrouted']
	)
	for (const filters of [
		{ provider_id: 'provider' },
		{ route_group: 'default' },
		{ status: 'active' },
	])
		assert.deepEqual(
			buildRouteWorkspace(
				[model, unrouted],
				[pool],
				validateRouteFilters(filters)
			).map((group) => group.id),
			['model']
		)
	assert.deepEqual(
		buildRouteWorkspace(
			[model, unrouted],
			[pool],
			validateRouteFilters({ q: 'unrouted' })
		).map((group) => group.id),
		['unrouted']
	)
	assert.equal(
		buildRouteWorkspace(
			[model],
			[pool],
			validateRouteFilters({ kind: 'image' })
		).length,
		0
	)
	assert.equal(
		buildRouteWorkspace(
			[model],
			[pool],
			validateRouteFilters({ invalid: true })
		).length,
		0
	)
})

test('effective strategy applies tier→pool→operation→protocol→model→global→default precedence', () => {
	assert.deepEqual(
		effectiveRouteStrategy(
			{
				...pool,
				tierStrategies: '{"10":"weight_priority"}',
				strategy: 'weighted_random',
			},
			model,
			'weighted_round_robin',
			10
		),
		{ strategy: 'weight_priority', source: 'tier' }
	)
	assert.equal(
		effectiveRouteStrategy(
			{ ...pool, strategy: 'weighted_random' },
			model,
			null
		).source,
		'pool'
	)
	assert.equal(
		effectiveRouteStrategy(pool, model, null).source,
		'modelOperation'
	)
	assert.equal(
		effectiveRouteStrategy(
			{ ...pool, surface: { ...pool.surface, request_operation: 'responses' } },
			model,
			null
		).source,
		'modelProtocol'
	)
	assert.equal(
		effectiveRouteStrategy({ ...pool, group: 'premium' }, model, null).source,
		'model'
	)
	assert.equal(
		effectiveRouteStrategy(
			pool,
			{ ...model, route_policy: null },
			'weighted_random'
		).source,
		'global'
	)
	assert.equal(
		effectiveRouteStrategy(pool, { ...model, route_policy: null }, 'invalid')
			.source,
		'default'
	)
})

test('priority layers are descending and preserve all target operations in each layer', () => {
	const tiers = groupPriorityTargets({
		...pool,
		targets: [{ ...row, id: 'low', priority: -1 }, row, { ...row, id: 'peer' }],
	})
	assert.deepEqual(
		tiers.map((tier) => tier.priority),
		[10, -1]
	)
	assert.deepEqual(
		tiers[0]?.targets.map((target) => target.id),
		['target', 'peer']
	)
})

test('pricing respects schedule mode/timezone and never presents malformed history as valid', () => {
	const price = {
		...row,
		price_override: JSON.stringify({
			charged_factor: 2,
			metered_factor: 3,
			schedule: {
				mode: 'multiply',
				charged: [{ start: '09:00', end: '12:00', days: [4], factor: 2 }],
				metered: [],
			},
		}),
	}
	assert.equal(
		routePriceSummary(price, 'UTC', new Date('2026-10-01T10:00:00Z'))?.charged,
		4
	)
	assert.equal(
		routePriceSummary(price, 'UTC', new Date('2026-10-01T14:00:00Z'))?.inverted,
		true
	)
	for (const raw of [
		'{broken',
		'[]',
		'{"charged_factor":-1}',
		'{"schedule":{"mode":"override","charged":[{"start":"99:00","end":"12:00","factor":1}],"metered":[]}}',
	])
		assert.equal(
			routePriceSummary({ ...row, price_override: raw }, 'UTC'),
			null
		)
	assert.equal(routePriceSummary(row, null), null)
	assert.equal(routePriceSummary(row, 'not-a-timezone'), null)
})
