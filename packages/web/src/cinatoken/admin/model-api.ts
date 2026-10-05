/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { z } from 'zod'
import {
	createAdminDomainTransport,
	type AdminDomainRequestOptions,
} from './domain-transport'
import { AdminDomainWriteError } from './domain-write-recovery'
import {
	modelCatalogResponseSchema,
	modelCreatedResponseSchema,
	modelIdentitySchema,
	modelImportResponseSchema,
	modelListResponseSchema,
	modelResponseSchema,
	modelSuccessSchema,
	type AdminModel,
	type ModelCatalog,
	type ModelDetailContext,
	type ModelImportResult,
	type ModelListContext,
} from './model-contracts'
import {
	createModelInput,
	modelImportIds,
	updateModelInput,
	ModelInputError,
	type CreateModelInput,
	type UpdateModelInput,
} from './model-input'

export type ModelRequestOptions = AdminDomainRequestOptions
export type ModelAdminTransport = {
	send<T>(
		path: string,
		schema: z.ZodType<T>,
		init: RequestInit,
		options: ModelRequestOptions
	): Promise<T>
	invalidResponse(message: string): never
	sanitizeError(error: unknown): Error
}
const root = '/api/admin/models'
function path(id: string): string {
	return root + '/' + encodeURIComponent(modelIdentitySchema.parse(id))
}
function json(method: string, input: unknown): RequestInit {
	return {
		method,
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(input),
	}
}

/** Console Cookie only. No workspace/Bearer metadata, retry, persistent cache, supplier write, or implicit currency conversion. */
export function createModelsApi(transport: ModelAdminTransport) {
	const bound = createAdminDomainTransport(transport, 'models')
	async function send<T>(
		url: string,
		schema: z.ZodType<T>,
		init: RequestInit,
		options: ModelRequestOptions
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
	function uniqueIds(rows: { id: string }[], count: number): void {
		if (
			count !== rows.length ||
			new Set(rows.map((row) => row.id)).size !== rows.length
		)
			transport.invalidResponse(
				'Model collection identity or count is inconsistent'
			)
	}
	async function modelListContext(
		options: ModelRequestOptions = {}
	): Promise<ModelListContext> {
		const result = await send(root, modelListResponseSchema, {}, options)
		uniqueIds(result.data, result.count)
		return { rows: result.data, billingCurrency: result.billing_currency }
	}
	async function modelContext(
		id: string,
		options: ModelRequestOptions = {}
	): Promise<ModelDetailContext> {
		const result = await send(path(id), modelResponseSchema, {}, options)
		if (result.data.id !== id)
			transport.invalidResponse('Server returned another model')
		return { row: result.data, billingCurrency: result.billing_currency }
	}
	return {
		verifyAdminDomainSubject: bound.verifyAdminDomainSubject,
		modelListContext,
		modelContext,
		modelList: async (
			options: ModelRequestOptions = {}
		): Promise<AdminModel[]> => {
			return (await modelListContext(options)).rows
		},
		model: async (
			id: string,
			options: ModelRequestOptions = {}
		): Promise<AdminModel> => {
			return (await modelContext(id, options)).row
		},
		modelCatalog: async (
			options: ModelRequestOptions = {}
		): Promise<ModelCatalog> => {
			const result = await send(
				root + '/import/catalog',
				modelCatalogResponseSchema,
				{},
				options
			)
			uniqueIds(result.data, result.count)
			return { items: result.data, billingCurrency: result.billing_currency }
		},
		createModel: async (
			input: CreateModelInput,
			options: ModelRequestOptions = {}
		): Promise<{ id: string }> => {
			const checked = createModelInput(input)
			const result = await send(
				root,
				modelCreatedResponseSchema,
				json('POST', checked),
				options
			)
			if (result.data.id !== checked.id)
				transport.invalidResponse('Server returned another created model')
			return result.data
		},
		updateModel: async (
			id: string,
			input: UpdateModelInput,
			options: ModelRequestOptions = {}
		): Promise<void> => {
			const checked = updateModelInput(input)
			if (
				checked.route_policy !== undefined &&
				checked.expected_route_policy === undefined
			)
				throw new ModelInputError()
			await send(path(id), modelSuccessSchema, json('PATCH', checked), options)
		},
		/** This is the real cascade delete, including model routes and tags. */
		deleteModel: async (
			id: string,
			options: ModelRequestOptions = {}
		): Promise<void> => {
			await send(path(id), modelSuccessSchema, { method: 'DELETE' }, options)
		},
		importModels: async (
			ids: string[],
			options: ModelRequestOptions = {}
		): Promise<ModelImportResult> => {
			const selected = modelImportIds(ids)
			const result = await send(
				root + '/import',
				modelImportResponseSchema,
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
				transport.invalidResponse('Model import outcomes are inconsistent')
			return result.data
		},
	}
}
export type ModelsApi = ReturnType<typeof createModelsApi>
