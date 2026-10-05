import type { z } from 'zod'
import {
	activityCsvExportSchema,
	activityFiltersSchema,
	activityGenerationIdSchema,
	activityGenerationResponseSchema,
	activityQuerySchema,
	activityResponseSchema,
	activityWorkspaceIdSchema,
	type ActivityCsvExport,
	type ActivityData,
	type ActivityFilters,
	type ActivityGeneration,
	type ActivityQuery,
} from './activity-contracts'
import { readActivityCsvResponse } from './activity-csv'
import type { RequestOptions } from './api'

export type ActivityRequestOptions = RequestOptions & {
	expectedWorkspaceId: string
}
type ActivityTransport = {
	send<T>(
		path: string,
		schema: z.ZodType<T>,
		init: RequestInit,
		options: RequestOptions,
		reader?: (response: Response) => Promise<unknown>
	): Promise<T>
	checkWorkspace(actual: string, options: RequestOptions): void
	invalidResponse(message: string): never
}

function queryFilters(options: ActivityFilters): ActivityFilters {
	return {
		range: options.range,
		api_key_id: options.api_key_id,
		model_id: options.model_id,
		provider_name: options.provider_name,
		status: options.status,
	}
}

function queryString(
	query: Record<string, string | number | undefined>
): string {
	const parameters = new URLSearchParams()
	for (const [key, value] of Object.entries(query))
		if (value !== undefined) parameters.set(key, String(value))
	return parameters.toString()
}

export function createActivityApi(transport: ActivityTransport) {
	return {
		activity: async (
			options: ActivityRequestOptions & ActivityQuery
		): Promise<ActivityData> => {
			activityWorkspaceIdSchema.parse(options.expectedWorkspaceId)
			const query = activityQuerySchema.parse({
				...queryFilters(options),
				page: options.page,
				page_size: options.page_size,
			})
			const result = await transport.send(
				`/api/user/activity?${queryString(query)}`,
				activityResponseSchema,
				{},
				options
			)
			const data = result.data
			transport.checkWorkspace(data.workspaceId, options)
			const pagination = data.pagination
			if (
				data.range.id !== query.range ||
				pagination.page !== query.page ||
				pagination.pageSize !== query.page_size ||
				pagination.totalPages !==
					Math.max(1, Math.ceil(pagination.total / pagination.pageSize)) ||
				data.logs.length > pagination.pageSize ||
				(data.logs.length > 0 &&
					pagination.total <
						(pagination.page - 1) * pagination.pageSize + data.logs.length) ||
				new Set(data.logs.map((row) => row.id)).size !== data.logs.length
			)
				transport.invalidResponse(
					'Server returned an inconsistent Activity page'
				)
			return data
		},
		activityGeneration: async (
			id: string,
			options: ActivityRequestOptions
		): Promise<ActivityGeneration> => {
			activityWorkspaceIdSchema.parse(options.expectedWorkspaceId)
			const generationId = activityGenerationIdSchema.parse(id)
			const result = await transport.send(
				`/api/user/activity/${generationId}`,
				activityGenerationResponseSchema,
				{},
				options
			)
			transport.checkWorkspace(result.data.workspace_id, options)
			if (result.data.id !== generationId)
				transport.invalidResponse('Server returned another generation')
			return result.data
		},
		/** Call outside query/mutation result caches; the UI owns and revokes any download Object URL. */
		exportActivityCsv: async (
			options: ActivityRequestOptions & ActivityFilters
		): Promise<ActivityCsvExport> => {
			activityWorkspaceIdSchema.parse(options.expectedWorkspaceId)
			const query = activityFiltersSchema.parse(queryFilters(options))
			const result = await transport.send(
				`/api/user/activity/export.csv?${queryString(query)}`,
				activityCsvExportSchema,
				{ headers: { Accept: 'text/csv' } },
				options,
				readActivityCsvResponse
			)
			transport.checkWorkspace(result.workspaceId, options)
			return result
		},
	}
}
