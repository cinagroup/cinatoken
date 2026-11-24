/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import type {
	AdminConfigRequestOptions,
	AdminConfigTransport,
} from './config-api'
import {
	adminConfigOverviewResponseSchema,
	streamTimeoutMsConfigurationSchema,
	streamTimeoutGroupsConfigurationSchema,
	type AdminConfigRevision,
	type StreamTimeoutConfiguration,
} from './config-contracts'
import {
	normalizeStreamTimeout,
	type StreamTimeoutField,
} from './config-stream-timeout'

const response = z.object({
	success: z.literal(true),
	data: z.object({
		streamFirstEventTimeoutMs: streamTimeoutMsConfigurationSchema.optional(),
		streamFirstEventTimeoutRouteGroups:
			streamTimeoutGroupsConfigurationSchema.optional(),
	}),
})
const paths = {
	streamFirstEventTimeoutMs: '/api/admin/config/stream-first-event-timeout-ms',
	streamFirstEventTimeoutRouteGroups:
		'/api/admin/config/stream-first-event-timeout-route-groups',
} as const
export function createStreamTimeoutApi(
	transport: AdminConfigTransport,
	verifySubject: (options: AdminConfigRequestOptions) => Promise<string>,
	revisionHeaders: (revision: AdminConfigRevision) => Record<string, string>
) {
	return {
		async readStreamTimeout(
			field: StreamTimeoutField,
			options: AdminConfigRequestOptions
		): Promise<{
			field: StreamTimeoutConfiguration | undefined
			canWrite: boolean
			canReveal: boolean
		}> {
			const bound = { ...options }
			try {
				const subject = await verifySubject(bound)
				bound.signal?.throwIfAborted()
				const result = await transport.send(
					'/api/admin/config/overview',
					adminConfigOverviewResponseSchema,
					{ headers: { 'X-CinaToken-Expected-Console-Subject': subject } },
					{ signal: bound.signal, timeoutMs: bound.timeoutMs }
				)
				bound.signal?.throwIfAborted()
				return {
					field: result.data[field],
					canWrite: result.data.canWrite,
					canReveal: result.data.canReveal,
				}
			} catch (error) {
				throw transport.sanitizeError(error)
			}
		},
		async updateStreamTimeout(
			field: StreamTimeoutField,
			input: string,
			expectedRevision: AdminConfigRevision,
			options: AdminConfigRequestOptions & { onDispatch: () => void }
		): Promise<StreamTimeoutConfiguration> {
			const value = normalizeStreamTimeout(field, input)
			const headers = revisionHeaders(expectedRevision)
			if (typeof options.onDispatch !== 'function') transport.invalidResponse()
			const onDispatch = options.onDispatch
			const bound = { ...options }
			try {
				const subject = await verifySubject(bound)
				bound.signal?.throwIfAborted()
				onDispatch()
				bound.signal?.throwIfAborted()
				const result = await transport.send(
					paths[field],
					response,
					{
						method: 'PUT',
						headers: {
							'Content-Type': 'application/json',
							...headers,
							'X-CinaToken-Expected-Console-Subject': subject,
						},
						body: JSON.stringify({ value }),
					},
					{ signal: bound.signal, timeoutMs: bound.timeoutMs }
				)
				bound.signal?.throwIfAborted()
				const saved = result.data[field]
				if (
					!saved ||
					saved.value !== value ||
					!saved.revision ||
					saved.revision.toLowerCase() === 'legacy' ||
					saved.revision.toLowerCase() === expectedRevision?.toLowerCase() ||
					saved.source === 'invalid'
				)
					transport.invalidResponse()
				return saved
			} catch (error) {
				throw transport.sanitizeError(error)
			}
		},
	}
}
