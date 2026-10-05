import { z } from 'zod'

const list = (maximum = 32) =>
	z.preprocess((value) => {
		let values = value
		if (typeof value === 'string') {
			if (value.length > 50_000) return []
			try {
				values = value.trim().startsWith('[')
					? JSON.parse(value)
					: value.split(',')
			} catch {
				return []
			}
		}
		if (!Array.isArray(values)) return []
		return [
			...new Set(
				values
					.filter(
						(item): item is string =>
							typeof item === 'string' &&
							item.length > 0 &&
							item.length <= 1_500 &&
							!Array.from(item).some(
								(character) => character.charCodeAt(0) < 32
							)
					)
					.map((item) => item.trim())
					.filter(Boolean)
			),
		].slice(0, maximum)
	}, z.array(z.string()))
const query = z.preprocess(
	(value) => (typeof value === 'string' ? value.slice(0, 500) : ''),
	z.string()
)
const page = z.coerce.number().int().min(1).max(100_000).catch(1)
export const modelCatalogSearchSchema = z.object({
	q: query,
	vendors: list(),
	inputs: list(),
	outputs: list(),
	protocols: list(),
	context: z.enum(['all', '128k', '1m']).catch('all'),
	sort: z.enum(['newest', 'context', 'price', 'name']).catch('newest'),
	view: z.enum(['list', 'table']).catch('list'),
	page,
})
export const providersSearchSchema = z.object({
	q: query,
	inputs: list(),
	outputs: list(),
	protocols: list(),
	sort: z.enum(['models', 'name', 'newest']).catch('models'),
	page,
})
export const compareSearchSchema = z.object({ models: list(4), q: query })
export const statsSearchSchema = z.object({
	range: z.enum(['7d', '30d', '90d']).catch('7d'),
	metric: z.enum(['popular', 'reliable', 'latency']).catch('popular'),
	q: query,
	page,
})
export type ModelCatalogSearch = z.infer<typeof modelCatalogSearchSchema>
export type ProvidersSearch = z.infer<typeof providersSearchSchema>
export type CompareSearch = z.infer<typeof compareSearchSchema>
export type StatsSearch = z.infer<typeof statsSearchSchema>
function input(value: unknown): Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {}
}
export const validateModelCatalogSearch = (
	value: unknown
): ModelCatalogSearch => {
	const parsed = input(value)
	if (
		parsed.outputs === undefined &&
		typeof parsed.output === 'string' &&
		parsed.output !== 'all'
	)
		return modelCatalogSearchSchema.parse({
			...parsed,
			outputs: [parsed.output],
		})
	return modelCatalogSearchSchema.parse(parsed)
}
export const validateProvidersSearch = (value: unknown): ProvidersSearch =>
	providersSearchSchema.parse(input(value))
export const validateCompareSearch = (value: unknown): CompareSearch =>
	compareSearchSchema.parse(input(value))
export const validateStatsSearch = (value: unknown): StatsSearch =>
	statsSearchSchema.parse(input(value))
