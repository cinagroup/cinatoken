/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	DEFAULT_ROUTE_STRATEGY,
	isRouteStrategyName,
	parseModelRoutePolicy,
	routePolicyRuleKey,
} from '@octafuse/core/db/model-route-policy'
import {
	findDailyWindowOverlap,
	parseRouteBaseFactors,
	parseRoutePricingSchedule,
	resolveDailyScheduleFactor,
	resolveEffectiveRouteFactor,
} from '@octafuse/core/db/pricing-schedule'
import { parseRoutePoolTierStrategies } from '@octafuse/core/db/route-pool-tier-strategies'
import type { AdminModel } from '../model-contracts'
import {
	filterRoutePools,
	routeModelVendor,
	type RouteFilters,
	type RoutePoolView,
	type RouteRow,
} from './route-domain'
import { routePriceOverrideSchema } from './routes-contracts'

export type StrategySource =
	| 'tier'
	| 'pool'
	| 'modelOperation'
	| 'modelProtocol'
	| 'model'
	| 'global'
	| 'default'
export function effectiveRouteStrategy(
	pool: RoutePoolView,
	model: AdminModel | undefined,
	globalStrategy: string | null,
	priority?: number
): { strategy: string; source: StrategySource } {
	const tier =
		priority === undefined
			? null
			: parseRoutePoolTierStrategies(pool.tierStrategies).get(priority)
	if (tier) return { strategy: tier, source: 'tier' }
	if (pool.strategy && isRouteStrategyName(pool.strategy))
		return { strategy: pool.strategy, source: 'pool' }
	const policy = parseModelRoutePolicy(model?.route_policy)
	if (pool.surface.request_operation !== '*') {
		const operation = policy?.rules.get(
			routePolicyRuleKey(
				pool.surface.request_protocol,
				pool.surface.request_operation,
				pool.group
			)
		)?.strategy
		if (operation) return { strategy: operation, source: 'modelOperation' }
	}
	const protocol = policy?.rules.get(
		routePolicyRuleKey(pool.surface.request_protocol, null, pool.group)
	)?.strategy
	if (protocol) return { strategy: protocol, source: 'modelProtocol' }
	if (policy?.strategy) return { strategy: policy.strategy, source: 'model' }
	if (globalStrategy && isRouteStrategyName(globalStrategy))
		return { strategy: globalStrategy, source: 'global' }
	return { strategy: DEFAULT_ROUTE_STRATEGY, source: 'default' }
}

export type RouteModelGroup = {
	id: string
	name: string
	vendor: string
	model: AdminModel | undefined
	pools: RoutePoolView[]
}
export function buildRouteWorkspace(
	models: AdminModel[],
	pools: RoutePoolView[],
	filters: RouteFilters
): RouteModelGroup[] {
	if (filters.invalid) return []
	const shown = filterRoutePools(pools, filters)
	const catalog = new Map(models.map((model) => [model.id, model]))
	const ids = new Set([...catalog.keys(), ...pools.map((pool) => pool.modelId)])
	const result: RouteModelGroup[] = []
	for (const id of ids) {
		const model = catalog.get(id)
		if (filters.model && id !== filters.model) continue
		if (filters.kind !== 'all' && model?.kind !== filters.kind) continue
		if (filters.vendor && routeModelVendor(model?.vendor) !== filters.vendor)
			continue
		const modelPools = shown.filter((pool) => pool.modelId === id)
		const existing = pools.filter((pool) => pool.modelId === id)
		if (existing.length && !modelPools.length) continue
		if (
			!existing.length &&
			(filters.provider_id || filters.route_group || filters.status !== 'all')
		)
			continue
		const name = model?.display_name || existing[0]?.modelName || id
		if (
			!existing.length &&
			filters.q &&
			![id, name, model?.vendor ?? ''].some((value) =>
				value.toLocaleLowerCase().includes(filters.q.toLocaleLowerCase())
			)
		)
			continue
		result.push({
			id,
			name,
			vendor: routeModelVendor(model?.vendor),
			model,
			pools: modelPools,
		})
	}
	return result.sort(
		(a, b) =>
			a.vendor.localeCompare(b.vendor) ||
			a.name.localeCompare(b.name) ||
			a.id.localeCompare(b.id)
	)
}

export function groupPriorityTargets(
	pool: RoutePoolView
): { priority: number; targets: RouteRow[] }[] {
	const tiers = new Map<number, RouteRow[]>()
	for (const target of pool.targets)
		tiers.set(target.priority, [...(tiers.get(target.priority) ?? []), target])
	return [...tiers]
		.sort(([a], [b]) => b - a)
		.map(([priority, targets]) => ({ priority, targets }))
}

/** Malformed historical pricing stays unknown. A provider fallback is not available in this DTO. */
export function routePriceSummary(
	row: RouteRow,
	timezone: string | null,
	now = new Date()
): {
	charged: number
	metered: number
	inverted: boolean
	scheduled: boolean
	windows: { side: 'chargedFactor' | 'meteredFactor'; text: string }[]
} | null {
	if (!timezone) return null
	try {
		new Intl.DateTimeFormat('en', { timeZone: timezone }).format(now)
	} catch {
		return null
	}
	if (row.price_override) {
		try {
			const value: unknown = JSON.parse(row.price_override)
			if (!routePriceOverrideSchema.safeParse(value).success) return null
			const raw = value as Record<string, unknown>
			for (const key of ['charged_factor', 'metered_factor'])
				if (
					raw[key] !== undefined &&
					(typeof raw[key] !== 'number' ||
						!Number.isFinite(raw[key]) ||
						raw[key] < 0)
				)
					return null
		} catch {
			return null
		}
	}
	const base = parseRouteBaseFactors(row.price_override)
	const schedule = parseRoutePricingSchedule(row.price_override)
	if (
		findDailyWindowOverlap(schedule.charged) ||
		findDailyWindowOverlap(schedule.metered)
	)
		return null
	if (row.price_override) {
		const parsed = routePriceOverrideSchema.parse(
			JSON.parse(row.price_override) as unknown
		)
		if (
			parsed.schedule &&
			(parsed.schedule.charged.length !== schedule.charged.length ||
				parsed.schedule.metered.length !== schedule.metered.length)
		)
			return null
	}
	const charged = resolveEffectiveRouteFactor(
		base.chargedFactor,
		resolveDailyScheduleFactor(schedule.charged, now, timezone),
		schedule.mode
	)
	const metered = resolveEffectiveRouteFactor(
		base.meteredFactor,
		resolveDailyScheduleFactor(schedule.metered, now, timezone),
		schedule.mode
	)
	return {
		charged,
		metered,
		inverted: charged < metered,
		scheduled: Boolean(schedule.charged.length || schedule.metered.length),
		windows: [
			...schedule.charged.map((window) => ({
				side: 'chargedFactor' as const,
				text: `${window.start}–${window.end} ×${window.factor} [${window.days?.join(',') ?? '*'}]`,
			})),
			...schedule.metered.map((window) => ({
				side: 'meteredFactor' as const,
				text: `${window.start}–${window.end} ×${window.factor} [${window.days?.join(',') ?? '*'}]`,
			})),
		],
	}
}
