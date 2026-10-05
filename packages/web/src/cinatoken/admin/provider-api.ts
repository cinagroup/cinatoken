import type { z } from 'zod'
import {
	createAdminDomainTransport,
	type AdminDomainRequestOptions,
} from './domain-transport'
import { AdminDomainWriteError } from './domain-write-recovery'
import {
	providerCatalogResponseSchema,
	providerCreatedResponseSchema,
	providerDashScopeResponseSchema,
	providerIdentitySchema,
	providerImportResponseSchema,
	providerListResponseSchema,
	providerResponseSchema,
	providerRevealResponseSchema,
	providerSuccessSchema,
	type AdminProvider,
	type ProviderCatalogItem,
	type ProviderDashScopeResource,
	type ProviderImportResult,
	type ProviderJsonObject,
} from './provider-contracts'
import {
	cloneProviderInput,
	createProviderInput,
	providerDashScopeInput,
	providerImportIds,
	updateProviderInput,
	ProviderInputError,
	type CloneProviderInput,
	type CreateProviderInput,
	type UpdateProviderInput,
} from './provider-input'
import {
	redactProviderResource,
	type ProviderDashScopeResult,
} from './provider-resource'

/** Admin is console-scoped, never an account/workspace-owned resource. */
export type ProviderRequestOptions = AdminDomainRequestOptions
export type ProviderDashScopeRequestOptions = ProviderRequestOptions & {
	knownSecrets?: readonly string[]
}
export type ProviderAdminTransport = {
	send<T>(
		path: string,
		schema: z.ZodType<T>,
		init: RequestInit,
		options: ProviderRequestOptions
	): Promise<T>
	invalidResponse(message: string): never
	sanitizeError(error: unknown): Error
}
const root = '/api/admin/providers'
function json(method: string, input: unknown): RequestInit {
	return {
		method,
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(input),
	}
}
function path(id: string): string {
	return root + '/' + encodeURIComponent(providerIdentitySchema.parse(id))
}

/** Inject the shared cookie transport; the factory neither retries nor stores credentials. */
export function createProvidersApi(transport: ProviderAdminTransport) {
	const bound = createAdminDomainTransport(transport, 'providers')
	async function send<T>(
		url: string,
		schema: z.ZodType<T>,
		init: RequestInit,
		options: ProviderRequestOptions
	): Promise<T> {
		try {
			options.signal?.throwIfAborted()
			// Copy only Admin options, including when a caller passes an account options object.
			const result = await bound.send(url, schema, init, options)
			options.signal?.throwIfAborted()
			return result
		} catch (error) {
			if (error instanceof AdminDomainWriteError) throw error
			throw transport.sanitizeError(error)
		}
	}
	function uniqueIds(rows: { id: string }[], count: number): void {
		if (
			count !== rows.length ||
			new Set(rows.map((row) => row.id)).size !== rows.length
		)
			transport.invalidResponse(
				'Provider collection identity or count is inconsistent'
			)
	}
	async function provider(
		id: string,
		options: ProviderRequestOptions = {}
	): Promise<AdminProvider> {
		const result = await send(path(id), providerResponseSchema, {}, options)
		if (result.data.id !== id)
			transport.invalidResponse('Server returned another provider')
		return result.data
	}
	async function createProvider(
		input: CreateProviderInput,
		options: ProviderRequestOptions = {}
	): Promise<{ id: string }> {
		const checked = createProviderInput(input)
		const result = await send(
			root,
			providerCreatedResponseSchema,
			json('POST', checked),
			options
		)
		if (checked.id && checked.id !== result.data.id)
			transport.invalidResponse('Server returned another created provider')
		return result.data
	}
	return {
		verifyAdminDomainSubject: bound.verifyAdminDomainSubject,
		provider,
		createProvider,
		providerList: async (
			options: ProviderRequestOptions = {}
		): Promise<AdminProvider[]> => {
			const result = await send(root, providerListResponseSchema, {}, options)
			uniqueIds(result.data, result.count)
			return result.data
		},
		providerCatalog: async (
			options: ProviderRequestOptions = {}
		): Promise<ProviderCatalogItem[]> => {
			const result = await send(
				root + '/import/catalog',
				providerCatalogResponseSchema,
				{},
				options
			)
			uniqueIds(result.data, result.count)
			return result.data
		},
		updateProvider: async (
			id: string,
			input: UpdateProviderInput,
			options: ProviderRequestOptions = {}
		): Promise<void> => {
			await send(
				path(id),
				providerSuccessSchema,
				json('PATCH', updateProviderInput(input)),
				options
			)
		},
		cloneProvider: async (
			id: string,
			input: CloneProviderInput,
			options: ProviderRequestOptions = {}
		): Promise<{ id: string }> => {
			const checked = cloneProviderInput(input)
			const source = await provider(id, options)
			if (
				source.endpointsState !== 'available' &&
				checked.endpoints === undefined
			)
				throw new ProviderInputError()
			return createProvider(
				{
					name: checked.name,
					id: checked.id,
					api_key: checked.api_key,
					description:
						checked.description === undefined
							? source.description
							: checked.description,
					endpoints:
						checked.endpoints === undefined
							? source.endpoints
							: checked.endpoints,
					shared_channel_type:
						checked.shared_channel_type === undefined
							? source.shared_channel_type
							: checked.shared_channel_type,
					status: 'disabled',
				},
				options
			)
		},
		deleteProvider: async (
			id: string,
			options: ProviderRequestOptions = {}
		): Promise<void> => {
			await send(path(id), providerSuccessSchema, { method: 'DELETE' }, options)
		},
		importProviders: async (
			ids: string[],
			options: ProviderRequestOptions = {}
		): Promise<ProviderImportResult> => {
			const selected = providerImportIds(ids)
			const result = await send(
				root + '/import',
				providerImportResponseSchema,
				json('POST', { ids: selected }),
				options
			)
			const outcomes = [
				...result.data.skipped_existing,
				...result.data.failed.map((item) => item.id),
			]
			if (
				result.data.created + outcomes.length !== selected.length ||
				new Set(outcomes).size !== outcomes.length ||
				outcomes.some((id) => !selected.includes(id))
			)
				transport.invalidResponse('Provider import outcomes are inconsistent')
			return result.data
		},
		/** Intentional secret path. UI must call inside a no-args/void mutation and keep only component memory. */
		revealProviderKey: async (
			id: string,
			options: ProviderRequestOptions = {}
		): Promise<string> => {
			const result = await send(
				path(id) + '/api-key',
				providerRevealResponseSchema,
				{},
				options
			)
			return result.data.api_key
		},
		/** Native resource operations retain their fields; redaction is explicit and component-memory only. */
		manageProviderDashScope: async (
			id: string,
			resource: ProviderDashScopeResource,
			input: ProviderJsonObject,
			options: ProviderDashScopeRequestOptions = {}
		): Promise<ProviderDashScopeResult> => {
			if (resource !== 'hotwords' && resource !== 'voices')
				transport.invalidResponse('Provider resource is unsupported')
			const result = await send(
				path(id) + '/dashscope/' + resource,
				providerDashScopeResponseSchema,
				json('POST', providerDashScopeInput(input)),
				options
			)
			return redactProviderResource(result, options.knownSecrets)
		},
	}
}
export type ProvidersApi = ReturnType<typeof createProvidersApi>
