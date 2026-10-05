import { z } from 'zod'
import {
	sharedKeyChannelSchema,
	type CreateSharedKeyInput,
	type PatchSharedKeyInput,
	type SharedKey,
	type SharedKeyCatalog,
} from '../../shared-key-contracts'

export function canManageSharedKeys(capabilities: readonly string[]): boolean {
	return capabilities.includes('shared_keys.manage')
}

const prefix = 'cinatoken.account.sharedKeys.'
function price(maximum: number | null, optional = false) {
	return z
		.string()
		.trim()
		.superRefine((value, context) => {
			if (optional && value === '') return
			const number = Number(value)
			if (
				!/^(?:\d+(?:\.\d{1,6})?|\.\d{1,6})$/u.test(value) ||
				!Number.isFinite(number) ||
				!Number.isSafeInteger(Math.round(number * 1_000_000)) ||
				number < 0 ||
				(!optional && number === 0) ||
				(maximum !== null && number > maximum)
			)
				context.addIssue({ code: 'custom', message: prefix + 'priceInvalid' })
		})
}
export function sharedKeyFormSchema(
	catalog: SharedKeyCatalog,
	editing: boolean
) {
	return z
		.object({
			channelType: sharedKeyChannelSchema,
			label: z
				.string()
				.trim()
				.max(128, prefix + 'labelInvalid'),
			apiKey: z.string(),
			weight: z
				.string()
				.trim()
				.regex(/^(?:[1-9]|[1-9]\d|100)$/u, prefix + 'weightInvalid'),
			inputPrice: price(catalog.limits.maxInputPrice),
			outputPrice: price(catalog.limits.maxOutputPrice),
			cacheReadPrice: price(null, true),
			cacheWritePrice: price(null, true),
		})
		.superRefine((value, context) => {
			if (
				!editing &&
				!catalog.channels.some(
					(channel) => channel.channelType === value.channelType
				)
			)
				context.addIssue({
					code: 'custom',
					path: ['channelType'],
					message: prefix + 'channelUnavailable',
				})
			if (!editing && value.apiKey.trim().length < 8)
				context.addIssue({
					code: 'custom',
					path: ['apiKey'],
					message: prefix + 'secretInvalid',
				})
			if (
				!editing &&
				new TextEncoder().encode(JSON.stringify(sharedKeyCreateInput(value)))
					.byteLength >
					2 * 1024 * 1024
			)
				context.addIssue({
					code: 'custom',
					path: ['apiKey'],
					message: prefix + 'tooLarge',
				})
		})
}
export type SharedKeyForm = {
	channelType: 'openai' | 'anthropic' | 'zhipu' | 'deepseek'
	label: string
	apiKey: string
	weight: string
	inputPrice: string
	outputPrice: string
	cacheReadPrice: string
	cacheWritePrice: string
}
export function sharedKeyDefaults(
	catalog: SharedKeyCatalog,
	row?: SharedKey
): SharedKeyForm {
	return {
		channelType:
			row?.channelType ?? catalog.channels[0]?.channelType ?? 'openai',
		label: row?.label ?? '',
		apiKey: '',
		weight: String(row?.weight ?? 10),
		inputPrice: row ? String(row.inputPrice) : '',
		outputPrice: row ? String(row.outputPrice) : '',
		cacheReadPrice:
			row?.cacheReadPrice == null ? '' : String(row.cacheReadPrice),
		cacheWritePrice:
			row?.cacheWritePrice == null ? '' : String(row.cacheWritePrice),
	}
}
export function sharedKeyPatchInput(
	values: SharedKeyForm
): PatchSharedKeyInput {
	return {
		label: values.label.trim() || null,
		weight: Number(values.weight),
		inputPrice: Number(values.inputPrice),
		outputPrice: Number(values.outputPrice),
		cacheReadPrice:
			values.cacheReadPrice.trim() === ''
				? null
				: Number(values.cacheReadPrice),
		cacheWritePrice:
			values.cacheWritePrice.trim() === ''
				? null
				: Number(values.cacheWritePrice),
	}
}
export function sharedKeyCreateInput(
	values: SharedKeyForm
): CreateSharedKeyInput {
	return {
		...sharedKeyPatchInput(values),
		channelType: values.channelType,
		apiKey: values.apiKey.trim(),
		weight: Number(values.weight),
		inputPrice: Number(values.inputPrice),
		outputPrice: Number(values.outputPrice),
	}
}
export function sharedKeyPage(
	rows: readonly SharedKey[],
	filters: { channel: string; status: string; search: string },
	page: number
) {
	const search = filters.search.trim().toLocaleLowerCase()
	const matching = rows.filter(
		(row) =>
			(!filters.channel || row.channelType === filters.channel) &&
			(!filters.status || row.status === filters.status) &&
			(!search ||
				[row.label, row.keyFingerprint, row.apiKeyMasked].some((value) =>
					value?.toLocaleLowerCase().includes(search)
				))
	)
	const pages = Math.max(1, Math.ceil(matching.length / 20))
	const current = Math.min(Math.max(0, page), pages - 1)
	return {
		rows: matching.slice(current * 20, (current + 1) * 20),
		total: matching.length,
		pages,
		page: current,
	}
}
