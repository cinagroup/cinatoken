/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { z } from 'zod'
import {
	createAdminDomainTransport,
	type AdminDomainRequestOptions,
} from './domain-transport'
import { AdminDomainWriteError } from './domain-write-recovery'
import {
	endpointBootstrapResponseSchema,
	endpointForeignIdSchema,
	endpointIdSchema,
	endpointListResponseSchema,
	endpointModelOptionsSchema,
	endpointProviderOptionsSchema,
	endpointResponseSchema,
	endpointRouteOptionsSchema,
	endpointStatusSchema,
	endpointSuccessSchema,
	endpointWriteResponseSchema,
	type AdminEndpoint,
	type EndpointBootstrapResult,
	type EndpointChoices,
	type EndpointMutationResult,
} from './endpoint-contracts'
import {
	checkedEndpointInput,
	type CreateEndpointInput,
	type UpdateEndpointInput,
} from './endpoint-input'

export type EndpointRequestOptions = AdminDomainRequestOptions
export type EndpointListQuery = {
	model_id?: string
	provider_id?: string
	status?: 'draft' | 'verified' | 'disabled'
}
export type EndpointAdminTransport = {
	send<T>(
		path: string,
		schema: z.ZodType<T>,
		init: RequestInit,
		options: EndpointRequestOptions
	): Promise<T>
	invalidResponse(message: string): never
	sanitizeError(error: unknown): Error
}
const root = '/api/admin/endpoints'
const json = (method: string, input: unknown): RequestInit => ({
	method,
	headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify(input),
})
const path = (id: string) =>
	root + '/' + encodeURIComponent(endpointIdSchema.parse(id))
function routePath(id: string): string {
	endpointForeignIdSchema.parse(id)
	if (id === '.' || id === '..') throw new TypeError('Invalid route identity')
	return encodeURIComponent(id)
}
/** Uses only the injected same-origin Console transport. No workspace or bearer context is forwarded. */
export function createEndpointsApi(transport: EndpointAdminTransport) {
	const bound = createAdminDomainTransport(transport, 'endpoints')
	async function send<T>(
		url: string,
		schema: z.ZodType<T>,
		init: RequestInit,
		options: EndpointRequestOptions
	): Promise<T> {
		try {
			options.signal?.throwIfAborted()
			const result = await bound.send(url, schema, init, options)
			options.signal?.throwIfAborted()
			return result
		} catch (error) {
			if (error instanceof AdminDomainWriteError) throw error
			throw transport.sanitizeError(error)
		}
	}
	function unique(rows: { id: string }[], count: number) {
		if (
			count !== rows.length ||
			new Set(rows.map((row) => row.id)).size !== rows.length
		)
			transport.invalidResponse(
				'Endpoint collection identity or count is inconsistent'
			)
	}
	return {
		verifyAdminDomainSubject: bound.verifyAdminDomainSubject,
		async endpointList(
			query: EndpointListQuery = {},
			options: EndpointRequestOptions = {}
		): Promise<AdminEndpoint[]> {
			const params = new URLSearchParams()
			for (const key of ['model_id', 'provider_id'] as const)
				if (query[key])
					params.set(key, endpointForeignIdSchema.parse(query[key]))
			if (query.status)
				params.set('status', endpointStatusSchema.parse(query.status))
			const result = await send(
				root + (params.size ? '?' + params.toString() : ''),
				endpointListResponseSchema,
				{},
				options
			)
			unique(result.data, result.count)
			if (
				result.data.some(
					(row) =>
						(query.model_id && row.model_id !== query.model_id) ||
						(query.provider_id && row.provider_id !== query.provider_id) ||
						(query.status && row.status !== query.status)
				)
			)
				transport.invalidResponse(
					'Endpoint list does not match the requested filter'
				)
			return result.data
		},
		async endpoint(
			id: string,
			options: EndpointRequestOptions = {}
		): Promise<AdminEndpoint> {
			const result = await send(path(id), endpointResponseSchema, {}, options)
			if (result.data.id !== id)
				transport.invalidResponse('Server returned another endpoint')
			return result.data
		},
		async createEndpoint(
			input: CreateEndpointInput,
			options: EndpointRequestOptions = {}
		): Promise<EndpointMutationResult> {
			return (
				await send(
					root,
					endpointWriteResponseSchema,
					json('POST', checkedEndpointInput(input, true)),
					options
				)
			).data
		},
		async updateEndpoint(
			id: string,
			input: UpdateEndpointInput,
			options: EndpointRequestOptions = {}
		): Promise<EndpointMutationResult> {
			const result = await send(
				path(id),
				endpointWriteResponseSchema,
				json('PATCH', checkedEndpointInput(input, false)),
				options
			)
			if (result.data.id !== id)
				transport.invalidResponse('Server returned another updated endpoint')
			return result.data
		},
		async deleteEndpoint(
			id: string,
			options: EndpointRequestOptions = {}
		): Promise<void> {
			await send(path(id), endpointSuccessSchema, { method: 'DELETE' }, options)
		},
		async linkEndpointRoute(
			id: string,
			routeId: string,
			options: EndpointRequestOptions = {}
		): Promise<void> {
			await send(
				path(id) + '/routes/' + routePath(routeId),
				endpointSuccessSchema,
				{ method: 'POST' },
				options
			)
		},
		async unlinkEndpointRoute(
			id: string,
			routeId: string,
			options: EndpointRequestOptions = {}
		): Promise<void> {
			await send(
				path(id) + '/routes/' + routePath(routeId),
				endpointSuccessSchema,
				{ method: 'DELETE' },
				options
			)
		},
		async bootstrapDeepSeekEndpoints(
			options: EndpointRequestOptions = {}
		): Promise<EndpointBootstrapResult> {
			const result = (
				await send(
					root + '/bootstrap/deepseek',
					endpointBootstrapResponseSchema,
					json('POST', { publish: true }),
					options
				)
			).data
			const models = result.models
			if (
				new Set(models.map((model) => model.model_id)).size !== models.length ||
				result.published !==
					models.filter((model) => model.status === 'published').length ||
				result.failed !==
					models.filter((model) => model.status === 'failed').length ||
				result.skipped !==
					models.filter((model) => model.status.startsWith('skipped_'))
						.length ||
				result.linked_routes !==
					models.reduce((sum, model) => sum + model.linked_routes, 0)
			)
				transport.invalidResponse('Bootstrap outcome counts are inconsistent')
			return result
		},
		async endpointChoices(
			options: EndpointRequestOptions = {}
		): Promise<EndpointChoices> {
			const [models, providers, routes] = await Promise.all([
				send('/api/admin/models', endpointModelOptionsSchema, {}, options),
				send(
					'/api/admin/providers',
					endpointProviderOptionsSchema,
					{},
					options
				),
				send('/api/admin/routes', endpointRouteOptionsSchema, {}, options),
			])
			for (const result of [models, providers, routes])
				unique(result.data, result.count)
			return {
				models: models.data,
				providers: providers.data,
				routes: routes.data,
			}
		},
	}
}
export type EndpointsApi = ReturnType<typeof createEndpointsApi>
