import type { z } from 'zod'
import type {
	CatalogModel,
	CatalogPricing,
	catalogProviderSchema,
	catalogStatsSchema,
} from './catalog-contracts'
import {
	validateStatsSearch,
	type ModelCatalogSearch,
	type ProvidersSearch,
	type StatsSearch,
} from './catalog-search'

export type CatalogProvider = z.infer<typeof catalogProviderSchema>
export type CatalogStat = z.infer<typeof catalogStatsSchema>['data'][number]
export type PriceUnit = 'token' | 'image' | 'second' | 'character'
export type PriceOverview = {
	unit: PriceUnit
	input: number | null
	output: number | null
}
export const PAGE_SIZE = 24
const catalogCollator = new Intl.Collator('en', { sensitivity: 'variant' })
const vendorCollator = new Intl.Collator('en', { sensitivity: 'base' })

/** Catalog ordering must not depend on the server or browser's default locale. */
export function compareCatalogText(left: string, right: string): number {
	return catalogCollator.compare(left, right)
}

export function validateBenchmarkSearch(value: unknown): StatsSearch {
	const input =
		typeof value === 'object' && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {}
	const metric =
		input.metric === 'popular' ||
		input.metric === 'reliable' ||
		input.metric === 'latency'
			? input.metric
			: 'latency'
	return validateStatsSearch({ ...input, metric })
}
export function modelName(model: CatalogModel): string {
	return model.display_name?.trim() || model.id
}
export function modelKey(model: Pick<CatalogModel, 'vendor' | 'slug'>): string {
	return `${encodeURIComponent(model.vendor)}:${model.slug}`
}
export function modelHref(
	model: Pick<CatalogModel, 'vendor' | 'slug'>
): string {
	return `/models/${encodeURIComponent(model.vendor)}/${encodeURIComponent(model.slug)}`
}
export function imageTokenMode(profile: CatalogPricing): boolean {
	return (
		profile.image_billing_mode === 'token' ||
		(profile.image_billing_mode === undefined &&
			profile.tiers.some((tier) =>
				[tier.image_input_price, tier.image_output_price].some(
					(price) => price !== null && price > 0
				)
			))
	)
}
export function priceOverview(profile: CatalogPricing | null): PriceOverview[] {
	if (!profile) return []
	const result: PriceOverview[] = []
	if (profile.image_billing_mode === 'per_image' && profile.image)
		result.push({
			unit: 'image',
			input: profile.image.input?.default ?? null,
			output: profile.image.default,
		})
	if (
		profile.audio_billing_mode === 'per_second' &&
		profile.audio &&
		'price_per_second' in profile.audio
	)
		result.push({
			unit: 'second',
			input: profile.audio.price_per_second,
			output: null,
		})
	if (
		profile.audio_billing_mode === 'per_character' &&
		profile.audio &&
		'price_per_character' in profile.audio
	)
		result.push({
			unit: 'character',
			input: profile.audio.price_per_character,
			output: null,
		})
	if (
		profile.image_billing_mode !== 'per_image' &&
		profile.audio_billing_mode !== 'per_second' &&
		profile.audio_billing_mode !== 'per_character'
	) {
		const tier = [...profile.tiers].sort(
			(a, b) => (a.upto ?? Infinity) - (b.upto ?? Infinity)
		)[0]
		if (tier)
			result.push({
				unit: 'token',
				input: tier.input_price,
				output: tier.output_price,
			})
	}
	return result
}
function comparePrices(a: CatalogModel, b: CatalogModel): number {
	const left = priceOverview(a.pricing_profile)
	const right = priceOverview(b.pricing_profile)
	const units: PriceUnit[] = ['token', 'image', 'second', 'character']
	const leftUnit =
		left.length === 1 ? units.indexOf(left[0]!.unit) : units.length
	const rightUnit =
		right.length === 1 ? units.indexOf(right[0]!.unit) : units.length
	if (leftUnit !== rightUnit) return leftUnit - rightUnit
	if (left.length !== 1 || right.length !== 1) return 0
	return (
		(left[0]?.input ?? left[0]?.output ?? Infinity) -
		(right[0]?.input ?? right[0]?.output ?? Infinity)
	)
}
const contains = (
	values: readonly string[] | null,
	selected: readonly string[]
) => selected.every((value) => values?.includes(value))
const timestamp = (value: string | null) =>
	value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : -Infinity
export function filterModels(
	models: readonly CatalogModel[],
	search: ModelCatalogSearch
): CatalogModel[] {
	const needle = search.q.trim().toLowerCase()
	const minimum = { all: 0, '128k': 128_000, '1m': 1_000_000 }[search.context]
	return models
		.filter(
			(model) =>
				(!needle ||
					[
						modelName(model),
						model.id,
						model.vendor,
						model.description ?? '',
						...model.tags,
					].some((value) => value.toLowerCase().includes(needle))) &&
				(!search.vendors.length ||
					search.vendors.some(
						(vendor) => vendorCollator.compare(vendor, model.vendor) === 0
					)) &&
				contains(model.input_modalities, search.inputs) &&
				contains(model.output_modalities, search.outputs) &&
				contains(model.protocols, search.protocols) &&
				(!minimum ||
					(model.context_window !== null && model.context_window >= minimum))
		)
		.sort((a, b) => {
			let delta = 0
			if (search.sort === 'newest')
				delta = timestamp(b.released_at) - timestamp(a.released_at)
			if (search.sort === 'context')
				delta =
					(b.context_window ?? -Infinity) - (a.context_window ?? -Infinity)
			if (search.sort === 'price') delta = comparePrices(a, b)
			return (
				(Number.isNaN(delta) ? 0 : delta) ||
				compareCatalogText(modelName(a), modelName(b))
			)
		})
}
export function filterProviders(
	providers: readonly CatalogProvider[],
	search: ProvidersSearch
): CatalogProvider[] {
	const needle = search.q.trim().toLowerCase()
	return providers
		.filter(
			(provider) =>
				(!needle ||
					[provider.id, provider.display_name].some((value) =>
						value.toLowerCase().includes(needle)
					)) &&
				contains(provider.protocols, search.protocols) &&
				contains(provider.input_modalities, search.inputs) &&
				contains(provider.output_modalities, search.outputs)
		)
		.sort((a, b) => {
			let delta = 0
			if (search.sort === 'models') delta = b.model_count - a.model_count
			if (search.sort === 'newest')
				delta =
					timestamp(b.latest_released_at) - timestamp(a.latest_released_at)
			return (
				(Number.isNaN(delta) ? 0 : delta) ||
				compareCatalogText(a.display_name, b.display_name)
			)
		})
}
export function sortStats(
	rows: readonly CatalogStat[],
	search: StatsSearch
): CatalogStat[] {
	const needle = search.q.trim().toLowerCase()
	return rows
		.filter(
			(row) =>
				!needle ||
				[row.id, row.display_name, row.vendor].some((value) =>
					value.toLowerCase().includes(needle)
				)
		)
		.sort((a, b) => {
			let delta = b.request_count - a.request_count
			if (search.metric === 'reliable')
				delta = b.success_rate - a.success_rate || delta
			if (search.metric === 'latency') {
				const latency =
					(a.avg_latency_ms ?? Infinity) - (b.avg_latency_ms ?? Infinity)
				delta = (Number.isNaN(latency) ? 0 : latency) || delta
			}
			return delta || compareCatalogText(a.display_name, b.display_name)
		})
}
export function paginate<T>(
	rows: readonly T[],
	requestedPage: number
): { rows: T[]; page: number; pages: number } {
	const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
	const page = Math.max(1, Math.min(pages, requestedPage))
	return {
		rows: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
		page,
		pages,
	}
}
export function facets(
	values: readonly (readonly string[] | null)[]
): string[] {
	return [...new Set(values.flatMap((value) => value ?? []))].sort((a, b) =>
		compareCatalogText(a, b)
	)
}
export function toggleFilter(
	values: readonly string[],
	value: string
): string[] {
	return values.includes(value)
		? values.filter((item) => item !== value)
		: [...values, value].slice(0, 32)
}
export function formatMoney(
	value: number,
	currency: string,
	locale: string
): string {
	return new Intl.NumberFormat(locale, {
		style: 'currency',
		currency,
		currencyDisplay: 'code',
		maximumSignificantDigits: 6,
	}).format(value)
}
