/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import { createAdminReliabilityApi } from '../reliability/reliability-api'
import type { ReliabilityDisplay } from '../reliability/reliability-contracts'
import {
	auditFilterOptionsResponseSchema,
	auditLogsResponseSchema,
	type AuditFilterOptions,
	type AuditLogPage,
} from './audit-log-contracts'
import {
	auditLogExportPath,
	auditLogsPath,
	type AuditLogSearch,
} from './audit-log-domain'

export type AuditLogOptions = { signal?: AbortSignal; timeoutMs?: number }
export type AuditLogTransport = {
	send<T>(
		path: string,
		schema: z.ZodType<T>,
		init: RequestInit,
		options: AuditLogOptions,
		reader?: (response: Response) => Promise<unknown>
	): Promise<T>
	invalidResponse(message?: string): never
	sanitizeError(error: unknown): Error
}

export function createAdminAuditLogsApi(transport: AuditLogTransport) {
	const display = createAdminReliabilityApi(transport).display
	const maxExportBytes = 8 * 1024 * 1024
	async function csvBlob(response: Response): Promise<Blob> {
		if (
			response.headers
				.get('Content-Type')
				?.split(';', 1)[0]
				?.trim()
				.toLowerCase() !== 'text/csv'
		)
			transport.invalidResponse('Audit export is not CSV')
		const declared = Number(response.headers.get('Content-Length'))
		if (Number.isFinite(declared) && declared > maxExportBytes)
			transport.invalidResponse('Audit export exceeds client limit')
		if (!response.body)
			transport.invalidResponse('Audit export body is missing')
		const reader = response.body.getReader()
		const chunks: Uint8Array[] = []
		let total = 0
		try {
			for (;;) {
				const { done, value } = await reader.read()
				if (done) break
				total += value.byteLength
				if (total > maxExportBytes) {
					await reader.cancel()
					transport.invalidResponse('Audit export exceeds client limit')
				}
				chunks.push(value)
			}
		} finally {
			reader.releaseLock()
		}
		const bytes = new Uint8Array(total)
		let offset = 0
		for (const chunk of chunks) {
			bytes.set(chunk, offset)
			offset += chunk.byteLength
		}
		const expectedHeader = new TextEncoder().encode(
			'\uFEFFaudit_id,created_at_utc,'
		)
		if (
			bytes.length < expectedHeader.length ||
			expectedHeader.some((byte, index) => bytes[index] !== byte)
		)
			transport.invalidResponse('Audit export header differs')
		return new Blob([bytes.buffer], { type: 'text/csv;charset=utf-8' })
	}
	async function read<T>(
		path: string,
		schema: z.ZodType<T>,
		options: AuditLogOptions
	): Promise<T> {
		try {
			options.signal?.throwIfAborted()
			const value = await transport.send(path, schema, {}, options)
			options.signal?.throwIfAborted()
			return value
		} catch (error) {
			throw transport.sanitizeError(error)
		}
	}
	return {
		auditLogDisplay(
			options: AuditLogOptions = {}
		): Promise<ReliabilityDisplay> {
			return display(options)
		},
		async auditLogs(
			search: AuditLogSearch,
			options: AuditLogOptions = {}
		): Promise<AuditLogPage> {
			const value = await read(
				auditLogsPath(search),
				auditLogsResponseSchema,
				options
			)
			if (value.page !== search.page || value.page_size !== 50)
				transport.invalidResponse('Audit-log page differs')
			return {
				data: value.data,
				total: value.total,
				page: value.page,
				page_size: value.page_size,
			}
		},
		async auditLogFilterOptions(
			options: AuditLogOptions = {}
		): Promise<AuditFilterOptions> {
			const value = await read(
				'/api/admin/budget-audit-logs/filters',
				auditFilterOptionsResponseSchema,
				options
			)
			return value.data
		},
		async exportAuditLogs(
			search: AuditLogSearch,
			options: AuditLogOptions = {}
		): Promise<Blob> {
			try {
				options.signal?.throwIfAborted()
				const blob = await transport.send(
					auditLogExportPath(search),
					z.instanceof(Blob),
					{ headers: { Accept: 'text/csv' } },
					options,
					csvBlob
				)
				options.signal?.throwIfAborted()
				return blob
			} catch (error) {
				throw transport.sanitizeError(error)
			}
		},
	}
}
export type AdminAuditLogsApi = ReturnType<typeof createAdminAuditLogsApi>
