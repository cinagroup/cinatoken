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
			try {
				options.signal?.throwIfAborted()
				const value = await transport.send(
					toolInvocationsPath(search),
					toolInvocationsResponseSchema,
					{},
					options
				)
				options.signal?.throwIfAborted()
				if (value.page !== search.page || value.page_size !== 50)
					transport.invalidResponse('Tool-invocation page differs')
				for (const row of value.data) {
					if (search.tool) {
						if (row.model_id !== `tool:${search.tool}`)
							transport.invalidResponse('Tool-invocation model differs')
					} else if (row.provider_id !== 'octafuse-tools') {
						transport.invalidResponse('Tool-invocation provider differs')
					}
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
