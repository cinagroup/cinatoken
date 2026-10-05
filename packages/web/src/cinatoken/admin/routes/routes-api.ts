/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { z } from 'zod'
import {
	createAdminDomainTransport,
	type AdminDomainRequestOptions,
} from '../domain-transport'
import { AdminDomainWriteError } from '../domain-write-recovery'
import {
	affinityHashSchema,
	createRouteInputSchema,
	routeCreatedResponseSchema,
	routeContextResponseSchema,
	routeIdentitySchema,
	routeListResponseSchema,
	routePoolPolicyPatchSchema,
	routeResponseSchema,
	routeSuccessSchema,
	stickyBindingClearResponseSchema,
	stickyBindingLookupQuerySchema,
	stickyBindingLookupResponseSchema,
	stickyBindingResetResponseSchema,
	stickyBindingsSummaryResponseSchema,
	updateRouteInputSchema,
	type AdminRoute,
	type AdminRouteDetail,
	type CreateRouteInput,
	type RoutePoolPolicyPatch,
	type RouteContext,
	type StickyBindingLookup,
	type StickyBindingLookupQuery,
	type StickyBindingsSummary,
	type UpdateRouteInput,
} from './routes-contracts'

export type RoutesRequestOptions = AdminDomainRequestOptions
export type RouteListQuery = { model_id?: string; provider_id?: string }
export type RoutesAdminTransport = {
	send<T>(
		path: string,
		schema: z.ZodType<T>,
		init: RequestInit,
		options: RoutesRequestOptions
	): Promise<T>
	invalidResponse(message: string): never
	sanitizeError(error: unknown): Error
}

const root = '/api/admin/routes'
const routePath = (id: string): string =>
	root + '/' + encodeURIComponent(routeIdentitySchema.parse(id))
const poolPath = (poolId: string): string =>
	root + '/pools/' + encodeURIComponent(routeIdentitySchema.parse(poolId))
const json = (method: string, value: unknown): RequestInit => ({
	method,
	headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify(value),
})

/** Same-origin Console Cookie transport only; never attaches workspace or bearer context. */
export function createRoutesApi(transport: RoutesAdminTransport) {
	const bound = createAdminDomainTransport(transport, 'routes')
	async function send<T>(
		path: string,
		schema: z.ZodType<T>,
		init: RequestInit,
		options: RoutesRequestOptions
	): Promise<T> {
		try {
			options.signal?.throwIfAborted()
			const result = await bound.send(path, schema, init, options)
			options.signal?.throwIfAborted()
			return result
		} catch (error) {
			if (error instanceof AdminDomainWriteError) throw error
			throw transport.sanitizeError(error)
		}
	}
	return {
		verifyAdminDomainSubject: bound.verifyAdminDomainSubject,
		async routeContext(
			options: RoutesRequestOptions = {}
		): Promise<RouteContext> {
			return (
				await send(root + '/context', routeContextResponseSchema, {}, options)
			).data
		},
		async routeList(
			query: RouteListQuery = {},
			options: RoutesRequestOptions = {}
		): Promise<AdminRoute[]> {
			const params = new URLSearchParams()
			if (query.model_id)
				params.set('model_id', routeIdentitySchema.parse(query.model_id))
			if (query.provider_id)
				params.set('provider_id', routeIdentitySchema.parse(query.provider_id))
			const result = await send(
				root + (params.size ? '?' + params.toString() : ''),
				routeListResponseSchema,
				{},
				options
			)
			if (
				result.count !== result.data.length ||
				new Set(result.data.map((route) => route.id)).size !==
					result.data.length
			)
				transport.invalidResponse('Route collection identities or count differ')
			if (
				result.data.some(
					(route) =>
						(query.model_id && route.model_id !== query.model_id) ||
						(query.provider_id && route.provider_id !== query.provider_id)
				)
			)
				transport.invalidResponse('Route list does not match requested filters')
			return result.data
		},
		async route(
			id: string,
			options: RoutesRequestOptions = {}
		): Promise<AdminRouteDetail> {
			const result = await send(routePath(id), routeResponseSchema, {}, options)
			if (result.data.id !== id)
				transport.invalidResponse('Server returned another route')
			return result.data
		},
		async createRoute(
			input: CreateRouteInput,
			options: RoutesRequestOptions = {}
		): Promise<{ id: string }> {
			return (
				await send(
					root,
					routeCreatedResponseSchema,
					json('POST', createRouteInputSchema.parse(input)),
					options
				)
			).data
		},
		async updateRoute(
			id: string,
			input: UpdateRouteInput,
			options: RoutesRequestOptions = {}
		): Promise<void> {
			await send(
				routePath(id),
				routeSuccessSchema,
				json('PATCH', updateRouteInputSchema.parse(input)),
				options
			)
		},
		async deleteRoute(
			id: string,
			options: RoutesRequestOptions = {}
		): Promise<void> {
			await send(
				routePath(id),
				routeSuccessSchema,
				{ method: 'DELETE' },
				options
			)
		},
		async patchRoutePoolPolicy(
			poolId: string,
			patch: RoutePoolPolicyPatch,
			options: RoutesRequestOptions = {}
		): Promise<void> {
			await send(
				poolPath(poolId),
				routeSuccessSchema,
				json('PATCH', routePoolPolicyPatchSchema.parse(patch)),
				options
			)
		},
		async stickyBindingsSummary(
			poolId: string,
			options: RoutesRequestOptions = {}
		): Promise<StickyBindingsSummary> {
			return (
				await send(
					poolPath(poolId) + '/sticky/bindings/summary',
					stickyBindingsSummaryResponseSchema,
					{},
					options
				)
			).data
		},
		async lookupStickyBinding(
			poolId: string,
			query: StickyBindingLookupQuery,
			options: RoutesRequestOptions = {}
		): Promise<StickyBindingLookup> {
			const checked = stickyBindingLookupQuerySchema.parse(query)
			const params = new URLSearchParams()
			for (const key of [
				'model_id',
				'route_group',
				'protocol',
				'request_operation',
				'user_id',
				'email',
			] as const) {
				if (checked[key]) params.set(key, checked[key])
			}
			const result = await send(
				poolPath(poolId) + '/sticky/bindings/lookup?' + params.toString(),
				stickyBindingLookupResponseSchema,
				{},
				options
			)
			if (checked.user_id && result.data.user_id !== checked.user_id)
				transport.invalidResponse('Sticky lookup resolved another user')
			return result.data
		},
		async clearStickyBinding(
			poolId: string,
			affinityHash: string,
			options: RoutesRequestOptions = {}
		): Promise<{ cleared: boolean }> {
			return (
				await send(
					poolPath(poolId) +
						'/sticky/bindings/' +
						encodeURIComponent(affinityHashSchema.parse(affinityHash)),
					stickyBindingClearResponseSchema,
					{ method: 'DELETE' },
					options
				)
			).data
		},
		async resetStickyBindings(
			poolId: string,
			options: RoutesRequestOptions = {}
		): Promise<{ sticky_epoch: number }> {
			return (
				await send(
					poolPath(poolId) + '/sticky/reset',
					stickyBindingResetResponseSchema,
					{ method: 'POST' },
					options
				)
			).data
		},
	}
}
export type RoutesApi = ReturnType<typeof createRoutesApi>
