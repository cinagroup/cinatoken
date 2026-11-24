/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createAdminReliabilityApi } from '../reliability/reliability-api'
import type { ReliabilityDisplay } from '../reliability/reliability-contracts'
import type {
	RequestLogOptions,
	RequestLogTransport,
} from '../request-logs/request-log-api'
import {
	toolInvocationsResponseSchema,
	type ToolInvocationPage,
} from './tool-invocation-contracts'
import {
	TOOL_INVOCATION_PROVIDERS,
	toolInvocationMatchesSearch,
	toolInvocationsPath,
	type ToolInvocationSearch,
} from './tool-invocation-domain'

export function createAdminToolInvocationsApi(transport: RequestLogTransport) {
	const display = createAdminReliabilityApi(transport).display
	return {
		toolInvocationDisplay(
			options: RequestLogOptions = {}
		): Promise<ReliabilityDisplay> {
			return display(options)
		},
		async toolInvocations(
			search: ToolInvocationSearch,
			options: RequestLogOptions = {}
		): Promise<ToolInvocationPage> {
			const snapshot = { ...search }
			options = { ...options }
			try {
				options.signal?.throwIfAborted()
				const path = toolInvocationsPath(snapshot)
				const prefix = new URLSearchParams(path.split('?')[1]).get(
					'model_id_prefix'
				)
				const value = await transport.send(
					path,
					toolInvocationsResponseSchema,
					{},
					options
				)
				options.signal?.throwIfAborted()
				if (value.page !== snapshot.page || value.page_size !== 50)
					transport.invalidResponse('Tool-invocation page differs')
				if (prefix && value.applied_filters?.model_id_prefix !== prefix)
					transport.invalidResponse(
						'Tool-invocation model prefix is unconfirmed'
					)
				if (
					snapshot.source === 'all' &&
					JSON.stringify(value.applied_filters?.provider_ids) !==
						JSON.stringify(TOOL_INVOCATION_PROVIDERS)
				)
					transport.invalidResponse(
						'Tool-invocation provider scope is unconfirmed'
					)
				for (const row of value.data) {
					if (!toolInvocationMatchesSearch(row, snapshot))
						transport.invalidResponse('Tool-invocation filter differs')
				}
				return {
					data: value.data,
					total: value.total,
					page: value.page,
					page_size: value.page_size,
				}
			} catch (error) {
				throw transport.sanitizeError(error)
			}
		},
	}
}
export type AdminToolInvocationsApi = ReturnType<
	typeof createAdminToolInvocationsApi
>
