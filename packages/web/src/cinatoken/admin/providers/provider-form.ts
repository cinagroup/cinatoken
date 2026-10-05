import { z } from 'zod'
import {
	providerIdentitySchema,
	type AdminProvider,
} from '../provider-contracts'
import {
	normalizeProviderEndpoints,
	PROVIDER_CAPABILITIES,
	PROVIDER_PROTOCOLS,
	type ProviderEndpoints,
	type ProviderProtocol,
} from '../provider-endpoints'
import type {
	CreateProviderInput,
	UpdateProviderInput,
} from '../provider-input'
import { providerEndpointSearchTerms } from './provider-endpoint-summary'

export type ProviderEditorMode = 'create' | 'edit' | 'clone'
export type EndpointDrafts = Record<
	ProviderProtocol,
	{
		base: string
		auth: 'auto' | 'query-key' | 'bearer'
		endpoints: Record<string, string>
	}
>
const draftSchema = z.record(
	z.enum(PROVIDER_PROTOCOLS),
	z.object({
		base: z.string(),
		auth: z.enum(['auto', 'query-key', 'bearer']),
		endpoints: z.record(z.string(), z.string()),
	})
)
const prefix = 'cinatoken.adminProviders.'
export const providerFormSchema = z
	.object({
		mode: z.enum(['create', 'edit', 'clone']),
		blockedEndpoints: z.boolean(),
		id: z
			.string()
			.trim()
			.refine(
				(value) => !value || providerIdentitySchema.safeParse(value).success,
				prefix + 'validationId'
			),
		name: z
			.string()
			.trim()
			.min(1, prefix + 'validationName'),
		description: z.string(),
		api_key: z.string(),
		status: z.enum(['active', 'disabled']),
		shared_channel_type: z.enum([
			'',
			'openai',
			'anthropic',
			'zhipu',
			'deepseek',
		]),
		endpointMode: z.enum(['keep', 'replace', 'clear']),
		endpoints: draftSchema,
	})
	.superRefine((values, context) => {
		if (
			values.mode !== 'edit' &&
			!values.api_key.trim() &&
			!values.shared_channel_type
		)
			context.addIssue({
				code: 'custom',
				path: ['api_key'],
				message: prefix + 'validationKey',
			})
		if (
			values.mode === 'clone' &&
			values.blockedEndpoints &&
			values.endpointMode === 'keep'
		)
			context.addIssue({
				code: 'custom',
				path: ['endpoints'],
				message: prefix + 'validationEndpointReplacement',
			})
		if (values.endpointMode === 'replace') {
			try {
				draftEndpoints(values.endpoints)
			} catch {
				context.addIssue({
					code: 'custom',
					path: ['endpoints'],
					message: prefix + 'validationEndpoints',
				})
			}
		}
	})
export type ProviderFormValues = z.infer<typeof providerFormSchema>

export function endpointDrafts(text: string | null): EndpointDrafts {
	let parsed: ProviderEndpoints = {}
	try {
		parsed = normalizeProviderEndpoints(text)
	} catch {
		/* Unavailable stored data must never become a write. */
	}
	const result = {} as EndpointDrafts
	for (const protocol of PROVIDER_PROTOCOLS) {
		const config = parsed[protocol]
		result[protocol] = {
			base: config?.base ?? '',
			auth: config?.auth ?? 'auto',
			endpoints: Object.fromEntries(
				PROVIDER_CAPABILITIES[protocol].map((capability) => [
					capability.replaceAll('.', '_'),
					config?.endpoints?.[capability] ?? '',
				])
			),
		}
	}
	return result
}
export function draftEndpoints(drafts: EndpointDrafts): ProviderEndpoints {
	const result: Record<string, unknown> = {}
	for (const protocol of PROVIDER_PROTOCOLS) {
		const draft = drafts[protocol]
		const endpoints = Object.fromEntries(
			Object.entries(draft.endpoints)
				.filter((entry) => entry[1].trim())
				.map(([capability, url]) => [capability.replaceAll('_', '.'), url])
		)
		if (!draft.base.trim() && !Object.keys(endpoints).length) continue
		const config: Record<string, unknown> = {}
		if (draft.base.trim()) config.base = draft.base
		if (Object.keys(endpoints).length) config.endpoints = endpoints
		if (protocol === 'gemini' && draft.auth !== 'auto') config.auth = draft.auth
		result[protocol] = config
	}
	return normalizeProviderEndpoints(result)
}
export function providerFormDefaults(
	mode: ProviderEditorMode,
	row?: AdminProvider
): ProviderFormValues {
	return {
		mode,
		blockedEndpoints: Boolean(row && row.endpointsState !== 'available'),
		id: mode === 'edit' ? (row?.id ?? '') : '',
		name: row?.name ?? '',
		description: row?.description ?? '',
		api_key: '',
		status: mode === 'edit' ? (row?.status ?? 'disabled') : 'disabled',
		shared_channel_type: row?.shared_channel_type ?? '',
		endpointMode:
			mode === 'edit' || Boolean(row && row.endpointsState !== 'available')
				? 'keep'
				: 'replace',
		endpoints: endpointDrafts(row?.endpoints ?? null),
	}
}
export function providerFormInput(
	values: ProviderFormValues
): CreateProviderInput | UpdateProviderInput {
	const parsed = providerFormSchema.parse(values)
	const result: UpdateProviderInput = {
		name: parsed.name,
		description: parsed.description || null,
		status: parsed.status,
		shared_channel_type: parsed.shared_channel_type || null,
	}
	if (parsed.api_key.trim()) result.api_key = parsed.api_key
	if (parsed.endpointMode === 'clear') result.endpoints = null
	if (parsed.endpointMode === 'replace')
		result.endpoints = draftEndpoints(parsed.endpoints)
	if (parsed.mode !== 'edit' && parsed.id.trim())
		return { ...result, name: parsed.name, id: parsed.id.trim() }
	return result
}

export const PROVIDER_LIST_FILTERS = [
	'all',
	'active',
	'disabled',
	'pending',
	'no_key',
	...PROVIDER_PROTOCOLS,
] as const
export type ProviderListFilter = (typeof PROVIDER_LIST_FILTERS)[number]
export type ProviderFilters = { q: string; filter: ProviderListFilter }
export function providerMatchesFilter(
	row: AdminProvider,
	filter: ProviderListFilter
): boolean {
	if (filter === 'all') return true
	if (filter === 'active' || filter === 'disabled') return row.status === filter
	if (filter === 'pending') return row.has_pending_key
	if (filter === 'no_key') return row.api_key === '(empty)'
	if (row.endpointsState !== 'available') return false
	return Boolean(normalizeProviderEndpoints(row.endpoints)[filter])
}
export function filterProviders(
	rows: AdminProvider[],
	filters: ProviderFilters
): AdminProvider[] {
	const q = filters.q.trim().toLowerCase()
	return rows
		.filter(
			(row) =>
				(!q ||
					[
						row.id,
						row.name,
						row.vendor_key,
						row.description ?? '',
						...providerEndpointSearchTerms(row),
					].some((value) => value.toLowerCase().includes(q))) &&
				providerMatchesFilter(row, filters.filter)
		)
		.sort((a, b) =>
			a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
		)
}
