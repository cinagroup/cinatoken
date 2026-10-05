import { z } from 'zod'
import {
	MODEL_INPUT_MODALITIES,
	MODEL_OUTPUT_MODALITIES,
} from '@octafuse/core/db/model-modalities'
import {
	parsePublicCatalogTopProviderSelection,
	PUBLIC_CATALOG_TOP_PROVIDER_METADATA_KEY,
} from '@octafuse/core/public-model-catalog'
import type {
	AdminModel,
	ModelKind,
	ParsedPricingProfile,
} from '../model-contracts'
import {
	createModelInput,
	updateModelInput,
	type CreateModelInput,
	type UpdateModelInput,
} from '../model-input'

export type ModelFilters = {
	q: string
	vendor: string
	kind: 'all' | ModelKind
	availability: 'all' | 'callable' | 'unrouted'
}
export const DEFAULT_MODEL_FILTERS: ModelFilters = {
	q: '',
	vendor: 'all',
	kind: 'all',
	availability: 'all',
}
export function filterModels(
	rows: AdminModel[],
	filters: ModelFilters
): AdminModel[] {
	const text = filters.q.trim().toLowerCase()
	return rows.filter(
		(row) =>
			(filters.vendor === 'all' || row.vendor === filters.vendor) &&
			(filters.kind === 'all' || row.kind === filters.kind) &&
			(filters.availability !== 'callable' || row.active_routes_count > 0) &&
			(filters.availability !== 'unrouted' || row.routes_count === 0) &&
			[row.id, row.display_name ?? '', row.description ?? '', ...row.tags].some(
				(value) => value.toLowerCase().includes(text)
			)
	)
}
export const TIER_PRICE_FIELDS = [
	'input_price',
	'output_price',
	'cache_read_price',
	'cache_write_price',
	'image_input_price',
	'image_input_cache_price',
	'image_output_price',
] as const
export type TierDraft = { upto: string; label: string } & Record<
	(typeof TIER_PRICE_FIELDS)[number],
	string
>
export type PriceMapDraft = { key: string; price: string }[]
export type ImageSideDraft = {
	default: string
	by_quality: PriceMapDraft
	by_size: PriceMapDraft
	by_quality_size: PriceMapDraft
}
export type PricingMode =
	| 'token'
	| 'image_token'
	| 'per_image'
	| 'audio_token'
	| 'per_second'
	| 'per_character'
export type PricingDraft = {
	mode: PricingMode
	tiers: TierDraft[]
	image: ImageSideDraft
	reference: ImageSideDraft
	policy: 'requested' | 'zero'
	audioPrice: string
	minimum: string
	advanced: boolean
	raw: string
}
export function emptyTier(): TierDraft {
	return {
		upto: '',
		label: '',
		input_price: '',
		output_price: '',
		cache_read_price: '',
		cache_write_price: '',
		image_input_price: '',
		image_input_cache_price: '',
		image_output_price: '',
	}
}
function side(value?: ParsedPricingProfile['image']): ImageSideDraft {
	const map = (values?: Record<string, number>): PriceMapDraft =>
		Object.entries(values ?? {}).map(([key, price]) => ({
			key,
			price: String(price),
		}))
	return {
		default: value?.default === undefined ? '' : String(value.default),
		by_quality: map(value?.by_quality),
		by_size: map(value?.by_size),
		by_quality_size: map(value?.by_quality_size),
	}
}
export function pricingDefaults(row?: AdminModel): PricingDraft {
	const profile = row?.pricing.profile
	let mode: PricingMode = 'token'
	if (row?.pricing.imageBillingMode === 'per_image') mode = 'per_image'
	else if (row?.pricing.imageBillingMode === 'token') mode = 'image_token'
	if (row?.pricing.audioBillingMode === 'token') mode = 'audio_token'
	else if (row?.pricing.audioBillingMode) mode = row.pricing.audioBillingMode
	const tiers = profile?.tiers.map(
		(tier) =>
			Object.fromEntries([
				['upto', tier.upto === null ? '' : String(tier.upto)],
				['label', tier.label ?? ''],
				...TIER_PRICE_FIELDS.map((field) => [
					field,
					tier[field] === null ? '' : String(tier[field]),
				]),
			]) as TierDraft
	) ?? [emptyTier()]
	const audio = profile?.audio
	const audioPrice =
		mode === 'per_character'
			? audio?.price_per_character
			: audio?.price_per_second
	const minimum =
		mode === 'per_character'
			? audio?.minimum_characters
			: audio?.minimum_seconds
	return {
		mode,
		tiers: tiers.length ? tiers : [emptyTier()],
		image: side(profile?.image),
		reference: side(profile?.image?.input),
		policy: profile?.image?.uncertain_result_policy ?? 'requested',
		audioPrice: audioPrice === undefined ? '' : String(audioPrice),
		minimum: minimum === undefined ? '' : String(minimum),
		advanced: false,
		raw: row?.pricing_profile ?? '',
	}
}
function number(raw: string, optional = false): number | null {
	if (!raw.trim()) {
		if (optional) return null
		throw new Error('Required price')
	}
	const value = Number(raw)
	if (!Number.isFinite(value)) throw new Error('Invalid price')
	return value
}
function nonNegativePrice(raw: string): number {
	const value = number(raw)!
	if (value < 0) throw new Error('Invalid price')
	return value
}
function imageSide(draft: ImageSideDraft): Record<string, unknown> {
	const result: Record<string, unknown> = {
		default: nonNegativePrice(draft.default),
	}
	for (const field of ['by_quality', 'by_size', 'by_quality_size'] as const) {
		const keys = draft[field].map((row) => row.key.trim().toLowerCase())
		if (keys.some((key) => !key) || new Set(keys).size !== keys.length)
			throw new Error('Invalid image map')
		if (keys.length)
			result[field] = Object.fromEntries(
				draft[field].map((row, index) => [
					keys[index],
					nonNegativePrice(row.price),
				])
			)
	}
	return result
}
export function pricingInput(
	draft: PricingDraft
): string | Record<string, unknown> {
	if (draft.advanced) return draft.raw
	if (draft.mode === 'per_image') {
		const image = imageSide(draft.image)
		if (draft.reference.default.trim()) image.input = imageSide(draft.reference)
		else if (
			(['by_quality', 'by_size', 'by_quality_size'] as const).some(
				(key) => draft.reference[key].length
			)
		)
			throw new Error('Reference default required')
		image.uncertain_result_policy = draft.policy
		return { image_billing_mode: 'per_image', image }
	}
	if (draft.mode === 'per_second' || draft.mode === 'per_character') {
		const unit = draft.mode === 'per_second' ? 'second' : 'character'
		const audio: Record<string, unknown> = {
			['price_per_' + unit]: nonNegativePrice(draft.audioPrice),
		}
		if (draft.minimum.trim()) {
			const minimum = nonNegativePrice(draft.minimum)
			if (draft.mode === 'per_character' && !Number.isSafeInteger(minimum))
				throw new Error('Invalid character minimum')
			audio['minimum_' + unit + 's'] = minimum
		}
		return { audio_billing_mode: draft.mode, audio }
	}
	const tiers = draft.tiers.map((tier) => {
		const value: Record<string, unknown> = { upto: number(tier.upto, true) }
		if (tier.label.trim()) value.label = tier.label.trim()
		for (const field of TIER_PRICE_FIELDS) {
			const price = number(
				tier[field],
				field !== 'input_price' && field !== 'output_price'
			)
			if (price !== null && field.startsWith('image_') && price < 0)
				throw new Error('Invalid image-token price')
			if (price !== null) value[field] = price
		}
		return value
	})
	const result: Record<string, unknown> = { tiers }
	if (draft.mode === 'image_token') result.image_billing_mode = 'token'
	if (draft.mode === 'audio_token') result.audio_billing_mode = 'token'
	return result
}
export type ModelFormValues = {
	id: string
	display_name: string
	vendor: string
	kind: ModelKind
	context_window: string
	max_tokens: string
	description: string
	released_at: string
	tags: string
	input_modalities: string[]
	output_modalities: string[]
	pricingAction: 'keep' | 'replace' | 'clear'
	pricing: PricingDraft
	metadata: string
	metadataAction: 'keep' | 'replace' | 'clear'
	topProviderEnabled: boolean
	endpointTag: string
	isModerated: boolean
	routePolicy: string
	routePolicyAction: 'keep' | 'replace' | 'clear'
}
const prefix = 'cinatoken.adminModels.'
export const modelFormSchema = z.object({
	id: z.string().min(1, prefix + 'validation'),
	display_name: z.string(),
	vendor: z.string(),
	kind: z.enum(['llm', 'image', 'audio', 'rerank']),
	context_window: z.string(),
	max_tokens: z.string(),
	description: z.string(),
	released_at: z.string(),
	tags: z.string(),
	input_modalities: z.array(z.string()),
	output_modalities: z.array(z.string()),
	pricingAction: z.enum(['keep', 'replace', 'clear']),
	pricing: z.custom<PricingDraft>(),
	metadata: z.string(),
	metadataAction: z.enum(['keep', 'replace', 'clear']),
	topProviderEnabled: z.boolean(),
	endpointTag: z.string(),
	isModerated: z.boolean(),
	routePolicy: z.string(),
	routePolicyAction: z.enum(['keep', 'replace', 'clear']),
})
export function modelFormDefaults(row?: AdminModel): ModelFormValues {
	let selection: ReturnType<typeof parsePublicCatalogTopProviderSelection> = {
		status: 'absent',
	}
	try {
		selection = parsePublicCatalogTopProviderSelection(
			JSON.parse(row?.metadata ?? '{}') as Record<string, unknown>
		)
	} catch {
		/* Keep malformed metadata untouched until explicit replacement. */
	}
	return {
		id: row?.id ?? '',
		display_name: row?.display_name ?? '',
		vendor: row?.vendor ?? 'other',
		kind: row?.kind ?? 'llm',
		context_window:
			row?.context_window === null || row?.context_window === undefined
				? ''
				: String(row.context_window),
		max_tokens:
			row?.max_tokens === null || row?.max_tokens === undefined
				? ''
				: String(row.max_tokens),
		description: row?.description ?? '',
		released_at: row?.released_at ?? '',
		tags: row?.tags.join(', ') ?? '',
		input_modalities: row?.inputModalities ?? ['text'],
		output_modalities: row?.outputModalities ?? ['text'],
		pricingAction: row ? 'keep' : 'replace',
		pricing: pricingDefaults(row),
		metadata: row?.metadata ?? '',
		metadataAction: row ? 'keep' : 'replace',
		topProviderEnabled: selection.status !== 'absent',
		endpointTag:
			selection.status === 'valid' ? selection.selector.endpointTag : '',
		isModerated: selection.status === 'valid' && selection.selector.isModerated,
		routePolicy: row?.route_policy ?? '',
		routePolicyAction: 'keep',
	}
}
export function modelFormInput(
	values: ModelFormValues,
	editing: boolean
): CreateModelInput | UpdateModelInput {
	const fields: UpdateModelInput = {
		display_name: values.display_name.trim() || null,
		vendor: values.vendor,
		context_window: number(values.context_window, true),
		max_tokens: number(values.max_tokens, true),
		description: values.description || null,
		released_at: values.released_at || null,
		tags: values.tags
			.split(',')
			.map((tag) => tag.trim())
			.filter(Boolean),
		input_modalities:
			values.input_modalities as UpdateModelInput['input_modalities'],
		output_modalities:
			values.output_modalities as UpdateModelInput['output_modalities'],
	}
	if (values.pricingAction === 'replace')
		fields.pricing_profile = pricingInput(values.pricing)
	else if (values.pricingAction === 'clear') fields.pricing_profile = null
	if (values.metadataAction === 'replace') {
		const metadata: unknown = values.metadata.trim()
			? JSON.parse(values.metadata)
			: {}
		if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
			throw new Error('Invalid metadata')
		const next = { ...(metadata as Record<string, unknown>) }
		delete next[PUBLIC_CATALOG_TOP_PROVIDER_METADATA_KEY]
		if (values.topProviderEnabled)
			next[PUBLIC_CATALOG_TOP_PROVIDER_METADATA_KEY] = {
				endpoint_tag: values.endpointTag,
				is_moderated: values.isModerated,
			}
		fields.metadata = Object.keys(next).length ? next : null
	} else if (values.metadataAction === 'clear') fields.metadata = null
	if (editing) {
		if (values.routePolicyAction === 'replace')
			fields.route_policy = values.routePolicy
		else if (values.routePolicyAction === 'clear') fields.route_policy = null
		return updateModelInput(fields)
	}
	return createModelInput({
		...fields,
		id: values.id,
		pricing_profile: fields.pricing_profile ?? '',
	} as CreateModelInput)
}
export { MODEL_INPUT_MODALITIES, MODEL_OUTPUT_MODALITIES }
