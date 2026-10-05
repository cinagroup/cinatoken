/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	normalizeModelRoutePolicyInput,
	parseModelRoutePolicy,
	routePolicyRuleKey,
	ROUTE_STRATEGY_NAMES,
} from '@octafuse/core/db/model-route-policy'
import {
	findDailyWindowOverlap,
	mergeScheduleSidesToSharedWindows,
	normalizeIsoWeekdays,
	parseHhMmToMinutes,
	parseRouteBaseFactors,
	parseRoutePricingSchedule,
	type DailyScheduleWindow,
} from '@octafuse/core/db/pricing-schedule'
import {
	isRouteAdapterCompatible,
	REQUEST_OPERATIONS_BY_PROTOCOL,
	ROUTE_ADAPTERS,
} from '@octafuse/core/route-topology'
import {
	UPSTREAM_PROTOCOLS,
	type UpstreamProtocol,
} from '@octafuse/core/upstream-protocol'
import { MODEL_VENDOR_OPTIONS } from '../model-input'
import type { AdminRoute } from './routes-contracts'

const modelVendorKeys = new Map(
	MODEL_VENDOR_OPTIONS.map((item) => [item.key.toLowerCase(), item.key])
)
export function routeModelVendor(value: unknown): string {
	return typeof value === 'string'
		? (modelVendorKeys.get(value.trim().toLowerCase()) ?? 'other')
		: 'other'
}
export function routeModelVendorLabel(value: string): string {
	return (
		MODEL_VENDOR_OPTIONS.find((item) => item.key === routeModelVendor(value))
			?.label ?? value
	)
}

export type RouteRow = AdminRoute

export type RouteSurface = {
	id: string | null
	request_protocol: string
	request_operation: string
	status: string
}

export type RoutePoolView = {
	key: string
	id: string | null
	modelId: string
	modelName: string
	group: string
	name: string | null
	strategy: string | null
	tierStrategies: string | null
	stickyEnabled: boolean
	stickyIdleTtlSeconds: number
	stickyEpoch: number
	status: string | null
	surface: RouteSurface
	targets: RouteRow[]
}

export type RouteFilters = {
	q: string
	model: string
	provider_id: string
	status: 'all' | 'active' | 'inactive'
	route_group: string
	kind: 'all' | 'llm' | 'image' | 'audio' | 'rerank'
	vendor: string
	workspace: 'byModel' | 'overview'
	view: 'topology' | 'summary'
	invalid?: true
}

export const emptyRouteFilters: RouteFilters = {
	q: '',
	model: '',
	provider_id: '',
	status: 'all',
	route_group: '',
	kind: 'all',
	vendor: '',
	workspace: 'byModel',
	view: 'topology',
}

export function validateRouteFilters(input: unknown): RouteFilters {
	const raw =
		input && typeof input === 'object' && !Array.isArray(input)
			? (input as Record<string, unknown>)
			: {}
	const short = (value: unknown): string =>
		typeof value === 'string'
			? Array.from(value)
					.filter((character) => {
						const code = character.charCodeAt(0)
						return code >= 32 && code !== 127
					})
					.join('')
					.trim()
					.slice(0, 200)
			: ''
	let invalid = raw.invalid !== undefined
	const fields = [
		'q',
		'model',
		'provider_id',
		'provider',
		'route_group',
		'group',
		'vendor',
		'status',
		'kind',
		'workspace',
		'view',
	]
	for (const key of fields) {
		if (raw[key] !== undefined && typeof raw[key] !== 'string') invalid = true
		if (
			typeof raw[key] === 'string' &&
			(Array.from(raw[key]).length > 200 || /[\p{Cc}\p{Cf}]/u.test(raw[key]))
		)
			invalid = true
	}
	function alias(canonical: string, legacy: string): string {
		if (
			raw[canonical] !== undefined &&
			raw[legacy] !== undefined &&
			short(raw[canonical]) !== short(raw[legacy])
		)
			invalid = true
		return short(raw[canonical] ?? raw[legacy])
	}
	const provider_id = alias('provider_id', 'provider')
	const route_group = alias('route_group', 'group')
	if (raw.status && !['all', 'active', 'inactive'].includes(String(raw.status)))
		invalid = true
	if (
		raw.kind &&
		!['all', 'llm', 'image', 'audio', 'rerank'].includes(String(raw.kind))
	)
		invalid = true
	if (raw.view && !['topology', 'summary'].includes(String(raw.view)))
		invalid = true
	if (raw.workspace && !['byModel', 'overview'].includes(String(raw.workspace)))
		invalid = true
	return {
		q: short(raw.q),
		model: short(raw.model),
		provider_id,
		status:
			raw.status === 'active' || raw.status === 'inactive' ? raw.status : 'all',
		route_group,
		kind: ['llm', 'image', 'audio', 'rerank'].includes(String(raw.kind))
			? (raw.kind as RouteFilters['kind'])
			: 'all',
		vendor: short(raw.vendor) ? routeModelVendor(raw.vendor) : '',
		workspace: raw.workspace === 'overview' ? 'overview' : 'byModel',
		view: raw.view === 'summary' ? 'summary' : 'topology',
		...(invalid ? { invalid: true as const } : {}),
	}
}

export function parseRouteSurfaces(row: RouteRow): RouteSurface[] {
	if (row.surfaces) {
		try {
			const raw: unknown = JSON.parse(row.surfaces)
			if (Array.isArray(raw)) {
				const surfaces = raw.flatMap((item): RouteSurface[] => {
					if (!item || typeof item !== 'object' || Array.isArray(item))
						return []
					const record = item as Record<string, unknown>
					if (
						typeof record.request_protocol !== 'string' ||
						typeof record.request_operation !== 'string'
					)
						return []
					return [
						{
							id: typeof record.id === 'string' ? record.id : null,
							request_protocol: record.request_protocol,
							request_operation: record.request_operation,
							status:
								typeof record.status === 'string' ? record.status : 'active',
						},
					]
				})
				if (surfaces.length) return surfaces
			}
		} catch {
			// A legacy or malformed surface cannot be used to assert request topology.
		}
	}
	return [
		{
			id: null,
			request_protocol: row.upstream_protocol,
			request_operation: '*',
			status: 'unknown',
		},
	]
}

export function buildRoutePools(rows: RouteRow[]): RoutePoolView[] {
	const groups = new Map<string, RoutePoolView>()
	for (const row of rows) {
		for (const surface of parseRouteSurfaces(row)) {
			const key = [
				row.model_id,
				row.route_pool_id ?? row.id,
				surface.id ??
					`${surface.request_protocol}.${surface.request_operation}`,
			].join('\0')
			let pool = groups.get(key)
			if (!pool) {
				pool = {
					key,
					id: row.route_pool_id,
					modelId: row.model_id,
					modelName: row.model_name || row.model_id,
					group: row.route_group,
					name: row.pool_name,
					strategy: row.pool_strategy,
					tierStrategies: row.pool_tier_strategies,
					stickyEnabled:
						row.pool_sticky_enabled === true || row.pool_sticky_enabled === 1,
					stickyIdleTtlSeconds:
						Number(row.pool_sticky_idle_ttl_seconds) || 3600,
					stickyEpoch: Number(row.pool_sticky_epoch) || 0,
					status: row.pool_status,
					surface,
					targets: [],
				}
				groups.set(key, pool)
			}
			if (!pool.targets.some((target) => target.id === row.id))
				pool.targets.push(row)
		}
	}
	return [...groups.values()]
		.map((pool) => ({
			...pool,
			targets: pool.targets.sort(
				(a, b) =>
					b.priority - a.priority ||
					(b.weight ?? 1) - (a.weight ?? 1) ||
					a.id.localeCompare(b.id)
			),
		}))
		.sort(
			(a, b) =>
				a.modelName.localeCompare(b.modelName) ||
				a.group.localeCompare(b.group) ||
				a.surface.request_protocol.localeCompare(b.surface.request_protocol) ||
				a.surface.request_operation.localeCompare(b.surface.request_operation)
		)
}

export function filterRoutePools(
	pools: RoutePoolView[],
	filters: RouteFilters
): RoutePoolView[] {
	const q = filters.q.trim().toLocaleLowerCase()
	return pools.flatMap((pool): RoutePoolView[] => {
		if (filters.model && pool.modelId !== filters.model) return []
		if (filters.route_group && pool.group !== filters.route_group) return []
		const targets = pool.targets.filter(
			(row) =>
				(!filters.provider_id || row.provider_id === filters.provider_id) &&
				(filters.status === 'all' || row.status === filters.status) &&
				(!q ||
					[
						pool.modelId,
						pool.modelName,
						pool.group,
						row.provider_id,
						row.provider_name,
						row.provider_model_name,
						row.id,
					].some((value) => value?.toLocaleLowerCase().includes(q)))
		)
		return targets.length ? [{ ...pool, targets }] : []
	})
}

export const routeProtocols = UPSTREAM_PROTOCOLS
export const routeStrategies = ROUTE_STRATEGY_NAMES
export const routeAdapters = ROUTE_ADAPTERS
export function routeOperations(protocol: string): readonly string[] {
	return protocol in REQUEST_OPERATIONS_BY_PROTOCOL
		? REQUEST_OPERATIONS_BY_PROTOCOL[protocol as UpstreamProtocol]
		: []
}

export type ScheduleDraft = {
	start: string
	end: string
	days: number[]
	chargedFactor: string
	meteredFactor: string
}

export type RouteDraft = {
	modelId: string
	providerId: string
	providerModelName: string
	requestProtocol: string
	requestOperation: string
	upstreamProtocol: string
	upstreamOperation: string
	adapter: string
	priority: string
	weight: string
	group: string
	chargedFactor: string
	meteredFactor: string
	schedule: ScheduleDraft[]
	customParams: string
	routingMetadata: string
}

export const emptyRouteDraft: RouteDraft = {
	modelId: '',
	providerId: '',
	providerModelName: '',
	requestProtocol: 'openai',
	requestOperation: 'chat',
	upstreamProtocol: 'openai',
	upstreamOperation: 'chat',
	adapter: 'passthrough',
	priority: '0',
	weight: '1',
	group: 'default',
	chargedFactor: '1',
	meteredFactor: '1',
	schedule: [],
	customParams: '',
	routingMetadata: '',
}

export function draftFromRoute(row: RouteRow): RouteDraft {
	const surface = parseRouteSurfaces(row)[0]!
	const base = parseRouteBaseFactors(row.price_override)
	const schedule = parseRoutePricingSchedule(row.price_override)
	const shared = mergeScheduleSidesToSharedWindows(
		schedule.charged,
		schedule.metered,
		{
			mode: schedule.mode,
			chargedBase: base.chargedFactor,
			meteredBase: base.meteredFactor,
		}
	)
	return {
		modelId: row.model_id,
		providerId: row.provider_id,
		providerModelName: row.provider_model_name,
		requestProtocol: surface.request_protocol,
		requestOperation: surface.request_operation,
		upstreamProtocol: row.upstream_protocol,
		upstreamOperation: row.upstream_operation,
		adapter: row.adapter,
		priority: String(row.priority),
		weight: String(row.weight ?? 1),
		group: row.route_group,
		chargedFactor: String(base.chargedFactor),
		meteredFactor: String(base.meteredFactor),
		schedule: shared.map((window) => ({
			start: window.start,
			end: window.end,
			days: window.days ?? [],
			chargedFactor: String(window.charged_factor),
			meteredFactor: String(window.metered_factor),
		})),
		customParams: row.custom_params ?? '',
		routingMetadata: row.routing_metadata ?? '',
	}
}

function jsonObjectText(raw: string, name: string): string | null {
	if (!raw.trim()) return null
	let value: unknown
	try {
		value = JSON.parse(raw)
	} catch {
		throw new Error(`${name}: invalid JSON`)
	}
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error(`${name}: expected object`)
	return JSON.stringify(value)
}

function nonNegative(raw: string, name: string): number {
	if (!raw.trim()) throw new Error(`${name}: required`)
	const number = Number(raw)
	if (!Number.isFinite(number) || number < 0)
		throw new Error(`${name}: non-negative number required`)
	return number
}

function priceOverride(draft: RouteDraft, original: string | null): string {
	let existing: Record<string, unknown> = {}
	if (original) {
		try {
			const parsed: unknown = JSON.parse(original)
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
				existing = { ...(parsed as Record<string, unknown>) }
		} catch {
			// A user explicitly changing the pricing form replaces malformed historical JSON.
		}
	}
	existing.charged_factor = nonNegative(draft.chargedFactor, 'chargedFactor')
	existing.metered_factor = nonNegative(draft.meteredFactor, 'meteredFactor')
	const charged: DailyScheduleWindow[] = []
	const metered: DailyScheduleWindow[] = []
	for (const [index, window] of draft.schedule.entries()) {
		const start = window.start.trim()
		const end = window.end.trim()
		if (
			parseHhMmToMinutes(start) == null ||
			start === '24:00' ||
			parseHhMmToMinutes(end) == null ||
			start === end
		)
			throw new Error(`schedule ${index + 1}: invalid time range`)
		const days = window.days.length
			? normalizeIsoWeekdays(window.days)
			: undefined
		if (days === null)
			throw new Error(`schedule ${index + 1}: invalid weekdays`)
		const common = { start, end, ...(days ? { days } : {}) }
		charged.push({
			...common,
			factor: nonNegative(
				window.chargedFactor,
				`schedule ${index + 1} chargedFactor`
			),
		})
		metered.push({
			...common,
			factor: nonNegative(
				window.meteredFactor,
				`schedule ${index + 1} meteredFactor`
			),
		})
	}
	const overlap = findDailyWindowOverlap(charged)
	if (overlap) throw new Error(`schedule: ${overlap}`)
	if (charged.length) existing.schedule = { mode: 'override', charged, metered }
	else delete existing.schedule
	return JSON.stringify(existing)
}

/** PATCH sends only edited fields. A target with ambiguous/missing surface never silently moves pools. */
export function buildRouteMutation(
	draft: RouteDraft,
	original?: RouteRow,
	choices?: { modelIds: readonly string[]; providerIds: readonly string[] }
): Record<string, unknown> {
	if (!draft.modelId || !draft.providerId || !draft.providerModelName.trim())
		throw new Error('target identity required')
	if (
		choices &&
		(!choices.modelIds.includes(draft.modelId) ||
			!choices.providerIds.includes(draft.providerId))
	)
		throw new Error('model or provider is not in the verified catalog')
	if (!draft.priority.trim()) throw new Error('priority required')
	const p = Number(draft.priority)
	const w = Number(draft.weight)
	if (!Number.isSafeInteger(p)) throw new Error('priority must be an integer')
	if (!Number.isSafeInteger(w) || w < 1)
		throw new Error('weight must be an integer ≥ 1')
	if (!draft.group.trim()) throw new Error('route group required')
	const knownProtocol = (value: string): value is UpstreamProtocol =>
		(UPSTREAM_PROTOCOLS as readonly string[]).includes(value)
	if (
		!knownProtocol(draft.requestProtocol) ||
		!knownProtocol(draft.upstreamProtocol)
	)
		throw new Error('invalid protocol')
	if (
		!routeOperations(draft.requestProtocol).includes(draft.requestOperation) &&
		draft.requestOperation !== '*'
	)
		throw new Error('invalid request operation')
	if (
		!routeOperations(draft.upstreamProtocol).includes(
			draft.upstreamOperation
		) &&
		draft.upstreamOperation !== '*'
	)
		throw new Error('invalid upstream operation')
	if (
		!isRouteAdapterCompatible({
			adapter: draft.adapter,
			requestProtocol: draft.requestProtocol,
			requestOperation: draft.requestOperation,
			upstreamProtocol: draft.upstreamProtocol,
			upstreamOperation: draft.upstreamOperation,
		})
	)
		throw new Error('adapter does not support this topology')
	const baseline = original ? draftFromRoute(original) : null
	const surfaceCount = original ? parseRouteSurfaces(original).length : 0
	const topologyChanged =
		!baseline ||
		[
			'modelId',
			'group',
			'requestProtocol',
			'requestOperation',
			'upstreamProtocol',
			'upstreamOperation',
			'adapter',
		].some(
			(field) =>
				draft[field as keyof RouteDraft] !== baseline[field as keyof RouteDraft]
		)
	if (
		original &&
		topologyChanged &&
		(surfaceCount !== 1 ||
			parseRouteSurfaces(original)[0]?.status === 'unknown')
	)
		throw new Error(
			'stored request surface is ambiguous; edit target fields without changing topology'
		)
	const result: Record<string, unknown> = {}
	function add(
		field: keyof RouteDraft,
		apiField: string,
		value: unknown
	): void {
		if (!baseline || draft[field] !== baseline[field]) result[apiField] = value
	}
	add('modelId', 'model_id', draft.modelId)
	add('providerId', 'provider_id', draft.providerId)
	add(
		'providerModelName',
		'provider_model_name',
		draft.providerModelName.trim()
	)
	add('priority', 'priority', p)
	add('weight', 'weight', w)
	add('group', 'route_group', draft.group.trim())
	if (topologyChanged) {
		result.request_protocol = draft.requestProtocol
		result.request_operation = draft.requestOperation
		result.upstream_protocol = draft.upstreamProtocol
		result.upstream_operation = draft.upstreamOperation
		result.adapter = draft.adapter
	}
	const pricingChanged =
		!baseline ||
		draft.chargedFactor !== baseline.chargedFactor ||
		draft.meteredFactor !== baseline.meteredFactor ||
		JSON.stringify(draft.schedule) !== JSON.stringify(baseline.schedule)
	if (pricingChanged)
		result.price_override = priceOverride(
			draft,
			original?.price_override ?? null
		)
	if (!baseline || draft.customParams !== baseline.customParams)
		result.custom_params = jsonObjectText(draft.customParams, 'customParams')
	if (!baseline || draft.routingMetadata !== baseline.routingMetadata)
		result.routing_metadata = jsonObjectText(
			draft.routingMetadata,
			'routingMetadata'
		)
	if (!original) result.status = 'inactive'
	return result
}

export type ModelPolicySelection = {
	protocol: string
	operation: string | null
	group: string
}

export function modelPolicyStrategy(
	raw: string | null,
	selection: ModelPolicySelection
): string | null {
	const key = routePolicyRuleKey(
		selection.protocol,
		selection.operation,
		selection.group
	)
	return parseModelRoutePolicy(raw)?.rules.get(key)?.strategy ?? null
}

/** Change one model rule without overwriting unrelated operation/group rules. */
export function modelPolicyPatch(
	raw: string | null,
	selection: ModelPolicySelection,
	strategy: string | null
): string | null {
	if (
		strategy &&
		!(ROUTE_STRATEGY_NAMES as readonly string[]).includes(strategy)
	)
		throw new Error('invalid model strategy')
	let parsed: Record<string, unknown> = {}
	if (raw) {
		try {
			const value: unknown = JSON.parse(raw)
			if (!value || typeof value !== 'object' || Array.isArray(value))
				throw new Error('invalid model policy')
			parsed = value as Record<string, unknown>
		} catch {
			throw new Error('stored model policy is invalid; edit in Models')
		}
	}
	const oldRules = parsed.rules
	if (
		oldRules != null &&
		(typeof oldRules !== 'object' || Array.isArray(oldRules))
	)
		throw new Error('stored model policy is invalid; edit in Models')
	const rules: Record<string, unknown> = {
		...(oldRules as Record<string, unknown> | undefined),
	}
	const key = routePolicyRuleKey(
		selection.protocol,
		selection.operation,
		selection.group
	)
	if (strategy) rules[key] = { strategy }
	else delete rules[key]
	if (Object.keys(rules).length) parsed.rules = rules
	else delete parsed.rules
	if (!parsed.strategy && !parsed.rules) return null
	return normalizeModelRoutePolicyInput(JSON.stringify(parsed))
}
