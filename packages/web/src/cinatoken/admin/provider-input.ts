import { z } from 'zod'
import {
	providerIdentitySchema,
	providerJson,
	providerSharedChannelSchema,
	providerStatusSchema,
	type ProviderJsonObject,
} from './provider-contracts'
import {
	normalizeProviderEndpoints,
	type ProviderEndpoints,
} from './provider-endpoints'

const inputFields = {
	name: z.string().trim().min(1).optional(),
	description: z.string().nullable().optional(),
	api_key: z.string().trim().optional(),
	status: providerStatusSchema.optional(),
	shared_channel_type: providerSharedChannelSchema.nullable().optional(),
	endpoints: z.unknown().optional(),
}
const createSchema = z
	.object({
		...inputFields,
		id: providerIdentitySchema.optional(),
		name: z.string().trim().min(1),
	})
	.strict()
const patchSchema = z.object(inputFields).strict()
const cloneSchema = z
	.object({
		...inputFields,
		id: providerIdentitySchema.optional(),
		name: z.string().trim().min(1),
		status: z.undefined().optional(),
	})
	.strict()

export type CreateProviderInput = {
	id?: string
	name: string
	description?: string | null
	api_key?: string
	status?: 'active' | 'disabled'
	shared_channel_type?: 'openai' | 'anthropic' | 'zhipu' | 'deepseek' | null
	endpoints?: ProviderEndpoints | string | null
}
export type UpdateProviderInput = Omit<CreateProviderInput, 'id' | 'name'> & {
	name?: string
}
export type CloneProviderInput = Omit<CreateProviderInput, 'status'>

export class ProviderInputError extends Error {
	constructor() {
		super('Provider input is invalid')
		this.name = 'ProviderInputError'
	}
}
function cleanEndpoints(value: unknown): ProviderEndpoints | null {
	const endpoints = normalizeProviderEndpoints(value)
	return Object.keys(endpoints).length ? endpoints : null
}
function parse<T>(run: () => T): T {
	try {
		return run()
	} catch {
		throw new ProviderInputError()
	}
}
export function createProviderInput(
	value: CreateProviderInput
): CreateProviderInput {
	return parse(() => {
		const checked = createSchema.parse(value)
		if (!checked.api_key && !checked.shared_channel_type)
			throw new ProviderInputError()
		return {
			...checked,
			...(checked.endpoints !== undefined
				? { endpoints: cleanEndpoints(checked.endpoints) }
				: {}),
		} as CreateProviderInput
	})
}
export function updateProviderInput(
	value: UpdateProviderInput
): UpdateProviderInput {
	return parse(() => {
		const checked = patchSchema.parse(value)
		const result = {
			...checked,
			...(checked.endpoints !== undefined
				? { endpoints: cleanEndpoints(checked.endpoints) }
				: {}),
		} as UpdateProviderInput
		// The actual PATCH contract treats an empty key as no change; omit it entirely.
		if (!result.api_key) delete result.api_key
		return result
	})
}
export function cloneProviderInput(
	value: CloneProviderInput
): CloneProviderInput {
	return parse(() => cloneSchema.parse(value) as CloneProviderInput)
}
export function providerImportIds(value: string[]): string[] {
	return parse(() =>
		z
			.array(providerIdentitySchema)
			.min(1)
			.parse([...new Set(value)])
	)
}
export function providerDashScopeInput(
	value: ProviderJsonObject
): ProviderJsonObject {
	return parse(() => {
		if (!value || typeof value !== 'object' || Array.isArray(value))
			throw new ProviderInputError()
		return providerJson(value) as ProviderJsonObject
	})
}
