/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { z } from 'zod'
import { createAdminReliabilityApi } from '../reliability/reliability-api'
import type { ReliabilityDisplay } from '../reliability/reliability-contracts'
import {
	logModelsCatalogSchema,
	logProvidersCatalogSchema,
	logRoutesCatalogSchema,
	requestLogsResponseSchema,
	type LogModelCatalog,
	type LogProviderCatalog,
	type LogRouteCatalog,
	type RequestLogPage,
} from './request-log-contracts'
import { requestLogDetailResponseSchema } from './request-log-detail-contracts'
import { requestLogsPath, type RequestLogSearch } from './request-log-domain'
import { requestLogIdSchema } from './request-log-target'

export type RequestLogOptions = { signal?: AbortSignal; timeoutMs?: number }
export type RequestLogTransport = {
	send<T>(
		path: string,
		schema: z.ZodType<T>,
		init: RequestInit,
		options: RequestLogOptions
	): Promise<T>
	invalidResponse(message?: string): never
	sanitizeError(error: unknown): Error
}

/** Every resource has its own permission. Catalog failures never gate logs.read or text filters. */
export function createAdminRequestLogsApi(transport: RequestLogTransport) {
	const display = createAdminReliabilityApi(transport).display
	async function send<T>(
		path: string,
		schema: z.ZodType<T>,
		options: RequestLogOptions
	): Promise<T> {
		try {
			options.signal?.throwIfAborted()
			const result = await transport.send(path, schema, {}, options)
			options.signal?.throwIfAborted()
			return result
		} catch (error) {
			throw transport.sanitizeError(error)
		}
	}
	function catalog<T extends { data: unknown[]; count: number }>(
		value: T
	): T['data'] {
		if (value.data.length !== value.count)
			transport.invalidResponse('Request-log catalog count differs')
		return value.data
	}
	return {
		async requestLogById(id: string, options: RequestLogOptions = {}) {
			const checked = requestLogIdSchema.parse(id)
			const result = await send(
				'/api/admin/request-logs/' + encodeURIComponent(checked),
				requestLogDetailResponseSchema,
				options
			)
			if (result.data.id !== checked)
				transport.invalidResponse('Request-log ID differs')
			return result.data
		},
		requestLogDisplay(
			options: RequestLogOptions = {}
		): Promise<ReliabilityDisplay> {
			return display(options)
		},
		async requestLogs(
			search: RequestLogSearch,
			options: RequestLogOptions = {}
		): Promise<RequestLogPage> {
			const value = await send(
				requestLogsPath(search),
				requestLogsResponseSchema,
				options
			)
			if (value.page !== search.page || value.page_size !== 50)
				transport.invalidResponse('Request-log page differs')
			return {
				data: value.data,
				total: value.total,
				page: value.page,
				page_size: value.page_size,
			}
		},
		async requestLogModels(
			options: RequestLogOptions = {}
		): Promise<LogModelCatalog> {
			return catalog(
				await send('/api/admin/models', logModelsCatalogSchema, options)
			)
		},
		async requestLogProviders(
			options: RequestLogOptions = {}
		): Promise<LogProviderCatalog> {
			return catalog(
				await send('/api/admin/providers', logProvidersCatalogSchema, options)
			)
		},
		async requestLogRoutes(
			options: RequestLogOptions = {}
		): Promise<LogRouteCatalog> {
			return catalog(
				await send('/api/admin/routes', logRoutesCatalogSchema, options)
			)
		},
	}
}
export type AdminRequestLogsApi = ReturnType<typeof createAdminRequestLogsApi>
