/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import type {
	AudioEndpointPricingOperation,
	AudioTokenPricingRates,
	ImageCapabilityDescriptor,
	ImagePricingBillable,
	ImagePricingUnit,
} from '../../../../../core/src/model-endpoint-catalog'
import type {
	AdminEndpoint,
	AudioEndpointCapabilities,
	EndpointStatus,
	ImageEndpointCapabilities,
} from '../endpoint-contracts'
import {
	checkedEndpointInput,
	type CreateEndpointInput,
	type UpdateEndpointInput,
} from '../endpoint-input'

export const ENDPOINT_PRICE_FIELDS = [
	'prompt',
	'completion',
	'request',
	'image',
	'image_output',
	'input_cache_read',
	'input_cache_write',
	'audio',
	'audio_output',
	'discount',
	'image_token',
	'input_audio_cache',
	'input_cache_write_1h',
	'internal_reasoning',
	'web_search',
] as const
export const ENDPOINT_TRAITS = [
	'implicit_caching',
	'voice_cloning',
	'auto',
	'function',
	'none',
	'required',
] as const
export const AUDIO_RATE_FIELDS = [
	'input_audio',
	'input_text',
	'output_text',
	'output_audio',
	'input_audio_cache',
] as const
export type TriState = 'unknown' | 'true' | 'false'
export type ImageParameterDraft = {
	name: string
	type: 'boolean' | 'enum' | 'range'
	values: string[]
	min: string
	max: string
}
export type ImagePriceDraft = {
	billable: ImagePricingBillable
	unit: ImagePricingUnit
	cost_usd: string
	variant: string
}
export type ImageDraft = {
	enabled: boolean
	provider_tag: string
	streaming: TriState
	passthrough: string
	parameters: ImageParameterDraft[]
	prices: ImagePriceDraft[]
}
export type AudioOperationDraft = {
	operation: AudioEndpointPricingOperation
	kind: 'duration' | 'characters' | 'tokens'
	price: string
	minimum: string
	increment: string
	request: string
	discount: string
	rates: Record<keyof AudioTokenPricingRates, string>
}
/** Core catalog permits token metering only for base transcription, and character metering only for speech. */
export function audioMeterKinds(
	operation: AudioEndpointPricingOperation
): readonly AudioOperationDraft['kind'][] {
	if (operation.startsWith('audio.speech')) return ['characters']
	if (operation === 'audio.transcriptions') return ['duration', 'tokens']
	return ['duration']
}
export type AudioDraft = {
	enabled: boolean
	operations: AudioOperationDraft[]
	speechEnabled: boolean
	defaultVoice: TriState
	referenceTypes: string
	defaultReferenceType: string
}
export type EndpointFormValues = {
	model_id: string
	provider_id: string
	provider_slug: string
	tag: string
	endpoint_class: '' | 'standard' | 'service_tier'
	region: string
	context_length: string
	max_prompt_tokens: string
	max_completion_tokens: string
	quantization: string
	supported_parameters: string
	pricingEnabled: boolean
	prices: Record<(typeof ENDPOINT_PRICE_FIELDS)[number], string>
	traits: Record<(typeof ENDPOINT_TRAITS)[number], TriState>
	image: ImageDraft
	audio: AudioDraft
	evidence_url: string
	expires_at: string
	status: EndpointStatus | 'keep'
}
const split = (value: string) => value.split(/[\s,]+/u).filter(Boolean)
const tri = (value: boolean | null | undefined): TriState => {
	if (value == null) return 'unknown'
	return value ? 'true' : 'false'
}
const boolean = (value: TriState): boolean | null => {
	if (value === 'unknown') return null
	return value === 'true'
}
export function endpointLocalTime(instant: string | null): string {
	if (!instant) return ''
	const date = new Date(instant)
	if (!Number.isFinite(date.getTime())) return ''
	const pad = (number: number, length = 2) =>
		String(number).padStart(length, '0')
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}
export function newAudioOperation(
	operation: AudioEndpointPricingOperation
): AudioOperationDraft {
	return {
		operation,
		kind: audioMeterKinds(operation)[0]!,
		price: '',
		minimum: '0',
		increment: '1',
		request: '',
		discount: '',
		rates: Object.fromEntries(
			AUDIO_RATE_FIELDS.map((key) => [key, ''])
		) as AudioOperationDraft['rates'],
	}
}
export function endpointFormDefaults(row?: AdminEndpoint): EndpointFormValues {
	const image = row?.image_capabilities,
		audio = row?.audio_capabilities
	const speech = audio?.speech_by_operation?.['audio.speech']
	const operations = Object.entries(audio?.pricing_by_operation ?? {}).map(
		([operation, pricing]) => {
			const draft = newAudioOperation(
				operation as AudioEndpointPricingOperation
			)
			if (!pricing) return draft
			draft.kind = pricing.meter.kind
			draft.request = pricing.request ?? ''
			draft.discount = pricing.discount?.toString() ?? ''
			if (pricing.meter.kind === 'tokens')
				draft.rates = { ...pricing.meter.rates }
			else {
				draft.price = pricing.meter.price
				draft.minimum = pricing.meter.minimum_units.toString()
				draft.increment = pricing.meter.increment_units.toString()
			}
			return draft
		}
	)
	return {
		model_id: row?.model_id ?? '',
		provider_id: row?.provider_id ?? '',
		provider_slug: row?.provider_slug ?? '',
		tag: row?.tag ?? '',
		endpoint_class: row ? (row.endpoint_class ?? '') : 'standard',
		region: row?.region ?? '',
		context_length: row?.context_length?.toString() ?? '',
		max_prompt_tokens: row?.max_prompt_tokens?.toString() ?? '',
		max_completion_tokens: row?.max_completion_tokens?.toString() ?? '',
		quantization: row?.quantization ?? '',
		supported_parameters: row?.supported_parameters.join(', ') ?? '',
		pricingEnabled: Boolean(row?.pricing),
		prices: Object.fromEntries(
			ENDPOINT_PRICE_FIELDS.map((key) => [
				key,
				row?.pricing?.[key]?.toString() ?? '',
			])
		) as EndpointFormValues['prices'],
		traits: {
			implicit_caching: tri(row?.supports_implicit_caching),
			voice_cloning: tri(row?.supports_voice_cloning),
			auto: tri(row?.supports_tool_choice.auto),
			function: tri(row?.supports_tool_choice.function),
			none: tri(row?.supports_tool_choice.none),
			required: tri(row?.supports_tool_choice.required),
		},
		image: {
			enabled: Boolean(image),
			provider_tag: image?.provider_tag ?? '',
			streaming: tri(image?.supports_streaming),
			passthrough: image?.allowed_passthrough_parameters.join(', ') ?? '',
			parameters: Object.entries(image?.supported_parameters ?? {}).map(
				([name, descriptor]) => ({
					name,
					type: descriptor.type,
					values: descriptor.type === 'enum' ? [...descriptor.values] : [],
					min: descriptor.type === 'range' ? String(descriptor.min) : '',
					max: descriptor.type === 'range' ? String(descriptor.max) : '',
				})
			),
			prices:
				image?.pricing.map((price) => ({
					...price,
					variant: price.variant ?? '',
				})) ?? [],
		},
		audio: {
			enabled: Boolean(audio),
			operations,
			speechEnabled: Boolean(speech),
			defaultVoice: tri(speech?.supports_default_voice),
			referenceTypes: speech?.reference_audio_media_types.join(', ') ?? '',
			defaultReferenceType: speech?.reference_audio_default_media_type ?? '',
		},
		evidence_url: row?.evidence_url ?? '',
		expires_at: endpointLocalTime(row?.expires_at ?? null),
		status: row ? 'keep' : 'draft',
	}
}
function imageFromForm(
	values: EndpointFormValues
): ImageEndpointCapabilities | null {
	const image = values.image
	if (!image.enabled) return null
	const supported_parameters: Record<string, ImageCapabilityDescriptor> = {}
	for (const parameter of image.parameters) {
		const name = parameter.name.trim()
		if (!name || Object.hasOwn(supported_parameters, name))
			throw new Error('Duplicate parameter')
		let descriptor: ImageCapabilityDescriptor = { type: 'boolean' }
		if (parameter.type === 'enum')
			descriptor = { type: 'enum', values: [...parameter.values] }
		if (parameter.type === 'range') {
			if (!parameter.min.trim() || !parameter.max.trim())
				throw new Error('Missing range')
			descriptor = {
				type: 'range',
				min: Number(parameter.min),
				max: Number(parameter.max),
			}
		}
		supported_parameters[name] = descriptor
	}
	return {
		provider_slug: values.provider_slug.trim().toLowerCase(),
		provider_tag: image.provider_tag.trim() || null,
		supports_streaming: boolean(image.streaming),
		supported_parameters,
		allowed_passthrough_parameters: split(image.passthrough),
		pricing: image.prices.map((price) => ({
			billable: price.billable,
			unit: price.unit,
			cost_usd: price.cost_usd.trim(),
			...(price.variant.trim() ? { variant: price.variant.trim() } : {}),
		})),
	}
}
function audioFromForm(
	values: EndpointFormValues
): AudioEndpointCapabilities | null {
	const audio = values.audio
	if (!audio.enabled) return null
	const pricing_by_operation: AudioEndpointCapabilities['pricing_by_operation'] =
		{}
	for (const operation of audio.operations) {
		if (Object.hasOwn(pricing_by_operation, operation.operation))
			throw new Error('Duplicate operation')
		let meter: NonNullable<
			AudioEndpointCapabilities['pricing_by_operation']['audio.speech']
		>['meter']
		if (operation.kind === 'tokens')
			meter = {
				kind: 'tokens',
				unit: 'token',
				rates: { ...operation.rates },
				require_authoritative_breakdown: true,
			}
		else {
			if (!operation.minimum.trim() || !operation.increment.trim())
				throw new Error('Missing meter units')
			const units = {
				price: operation.price.trim(),
				minimum_units: Number(operation.minimum),
				increment_units: Number(operation.increment),
			}
			meter =
				operation.kind === 'duration'
					? { kind: 'duration', unit: 'second', ...units }
					: { kind: 'characters', unit: 'unicode_code_point', ...units }
		}
		pricing_by_operation[operation.operation] = {
			currency: 'USD',
			meter,
			...(operation.request.trim()
				? { request: operation.request.trim() }
				: {}),
			...(operation.discount.trim()
				? { discount: Number(operation.discount) }
				: {}),
		}
	}
	return {
		v: 1,
		pricing_by_operation,
		...(audio.speechEnabled
			? {
					speech_by_operation: {
						'audio.speech': {
							supports_default_voice: boolean(audio.defaultVoice),
							reference_audio_media_types: split(audio.referenceTypes),
							reference_audio_default_media_type:
								audio.defaultReferenceType.trim() || null,
						},
					},
				}
			: {}),
	}
}
export function endpointFormInput(
	values: EndpointFormValues,
	row?: AdminEndpoint
): UpdateEndpointInput {
	let pricing: Record<string, unknown> | null = null
	if (values.pricingEnabled) {
		pricing = {
			currency: 'USD',
			prompt: values.prices.prompt.trim(),
			completion: values.prices.completion.trim(),
		}
		for (const key of ENDPOINT_PRICE_FIELDS)
			if (key !== 'prompt' && key !== 'completion' && values.prices[key].trim())
				pricing[key] =
					key === 'discount'
						? Number(values.prices[key])
						: values.prices[key].trim()
	}
	const expires = values.expires_at
		? new Date(values.expires_at).toISOString()
		: null
	const input = checkedEndpointInput(
		{
			model_id: values.model_id,
			provider_id: values.provider_id,
			provider_slug: values.provider_slug,
			tag: values.tag,
			endpoint_class: values.endpoint_class || null,
			region: values.region.trim() || null,
			context_length: values.context_length.trim()
				? Number(values.context_length)
				: null,
			max_prompt_tokens: values.max_prompt_tokens.trim()
				? Number(values.max_prompt_tokens)
				: null,
			max_completion_tokens: values.max_completion_tokens.trim()
				? Number(values.max_completion_tokens)
				: null,
			quantization: (values.quantization ||
				null) as UpdateEndpointInput['quantization'],
			supported_parameters: split(values.supported_parameters),
			pricing,
			supports_implicit_caching: boolean(values.traits.implicit_caching),
			supports_voice_cloning: boolean(values.traits.voice_cloning),
			supports_tool_choice: {
				auto: boolean(values.traits.auto),
				function: boolean(values.traits.function),
				none: boolean(values.traits.none),
				required: boolean(values.traits.required),
			},
			image_capabilities: imageFromForm(values),
			audio_capabilities: audioFromForm(values),
			evidence_url: values.evidence_url.trim() || null,
			expires_at:
				row && values.expires_at === endpointLocalTime(row.expires_at)
					? row.expires_at
					: expires,
			...(values.status === 'keep' ? {} : { status: values.status }),
		} as CreateEndpointInput,
		!row
	)
	if (!row) return input
	if (input.model_id !== row.model_id || input.provider_id !== row.provider_id)
		throw new Error('Immutable endpoint identity')
	const patch: UpdateEndpointInput = {}
	for (const key of Object.keys(input) as (keyof UpdateEndpointInput)[]) {
		if (key === 'model_id' || key === 'provider_id') continue
		if (
			key === 'status' ||
			JSON.stringify(input[key]) !== JSON.stringify(row[key])
		)
			Object.assign(patch, { [key]: input[key] })
	}
	return patch
}
export const endpointFormSchema = (row?: AdminEndpoint) =>
	z
		.custom<EndpointFormValues>(
			(value) => value !== null && typeof value === 'object'
		)
		.superRefine((value, context) => {
			try {
				endpointFormInput(value, row)
			} catch {
				context.addIssue({
					code: 'custom',
					path: ['root'],
					message: 'cinatoken.adminEndpoints.invalidInput',
				})
			}
		})
export function endpointIsExpired(
	row: AdminEndpoint,
	now = Date.now()
): boolean {
	return row.expires_at !== null && Date.parse(row.expires_at) <= now
}
