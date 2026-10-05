/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { z } from 'zod'
import {
	createAdminDomainTransport,
	type AdminDomainRequestOptions,
	type AdminDomainTransport,
} from '../domain-transport'
import { AdminDomainWriteError } from '../domain-write-recovery'
import {
	adminGuardrailAssignmentResponseSchema,
	adminGuardrailAssignmentsResponseSchema,
	adminGuardrailDeleteAssignmentResponseSchema,
	adminGuardrailDesignationSchema,
	adminGuardrailIdSchema,
	adminGuardrailScopeSchema,
	adminGuardrailStatusSchema,
	adminGuardrailSummariesResponseSchema,
	adminGuardrailSummaryResponseSchema,
	adminGuardrailVersionSummariesResponseSchema,
	type AdminGuardrailAssignment,
	type AdminGuardrailList,
	type AdminGuardrailScopeType,
	type AdminGuardrailSummary,
	type AdminGuardrailVersionSummary,
} from './guardrails-contracts'

export type AdminGuardrailsRequestOptions = AdminDomainRequestOptions
export type AdminGuardrailsTransport = AdminDomainTransport

const root = '/api/admin/guardrails'
const json = (method: string, value: unknown): RequestInit => ({
	method,
	headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify(value),
})

/** Same-origin Console Cookie transport, with no portal workspace or Bearer context. */
export function createAdminGuardrailsApi(transport: AdminGuardrailsTransport) {
	const bound = createAdminDomainTransport(transport, 'guardrails')
	function checked<T>(schema: z.ZodType<T>, value: unknown): T {
		try {
			return schema.parse(value)
		} catch (error) {
			throw transport.sanitizeError(error)
		}
	}
	function guardrailPath(id: string): string {
		return root + '/' + encodeURIComponent(checked(adminGuardrailIdSchema, id))
	}
	async function send<T>(
		path: string,
		schema: z.ZodType<T>,
		init: RequestInit,
		options: AdminGuardrailsRequestOptions
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
		async listGuardrails(
			options: AdminGuardrailsRequestOptions = {}
		): Promise<AdminGuardrailList> {
			const result = await send(
				root + '/summaries',
				adminGuardrailSummariesResponseSchema,
				{},
				options
			)
			if (
				result.count !== result.data.length ||
				new Set(result.data.map((row) => row.id)).size !== result.data.length
			)
				transport.invalidResponse('Guardrail collection identities differ')
			return { rows: result.data, canWrite: result.canWrite }
		},
		async listGuardrailVersions(
			id: string,
			options: AdminGuardrailsRequestOptions = {}
		): Promise<AdminGuardrailVersionSummary[]> {
			const checkedId = checked(adminGuardrailIdSchema, id)
			const result = await send(
				guardrailPath(checkedId) + '/version-summaries',
				adminGuardrailVersionSummariesResponseSchema,
				{},
				options
			)
			const versions = result.data.versions
			if (
				result.data.guardrailId !== checkedId ||
				result.data.total !== versions.length ||
				new Set(versions.map((row) => row.id)).size !== versions.length ||
				new Set(versions.map((row) => row.version)).size !== versions.length
			)
				transport.invalidResponse('Guardrail version identities differ')
			return versions
		},
		async listGuardrailAssignments(
			row: Pick<AdminGuardrailSummary, 'id' | 'workspaceId'>,
			options: AdminGuardrailsRequestOptions = {}
		): Promise<AdminGuardrailAssignment[]> {
			const checkedId = checked(adminGuardrailIdSchema, row.id)
			const result = await send(
				guardrailPath(checkedId) + '/assignments',
				adminGuardrailAssignmentsResponseSchema,
				{},
				options
			)
			if (
				result.data.some(
					(value) =>
						value.guardrailId !== checkedId ||
						value.workspaceId !== row.workspaceId
				) ||
				new Set(result.data.map((value) => value.id)).size !==
					result.data.length
			)
				transport.invalidResponse('Guardrail assignments differ')
			return result.data
		},
		async setGuardrailStatus(
			row: AdminGuardrailSummary,
			status: 'active' | 'archived',
			options: AdminGuardrailsRequestOptions = {}
		): Promise<AdminGuardrailSummary> {
			const checkedStatus = checked(adminGuardrailStatusSchema, status)
			const result = await send(
				guardrailPath(row.id) + '?view=summary',
				adminGuardrailSummaryResponseSchema,
				json('PATCH', { status: checkedStatus }),
				options
			)
			if (
				result.data.id !== row.id ||
				result.data.workspaceId !== row.workspaceId ||
				result.data.ownerUserId !== row.ownerUserId ||
				result.data.status !== checkedStatus
			)
				throw new AdminDomainWriteError('unknown', 200)
			return result.data
		},
		async designateGuardrail(
			row: AdminGuardrailSummary,
			version: number,
			options: AdminGuardrailsRequestOptions = {}
		): Promise<AdminGuardrailSummary> {
			const checkedVersion = checked(adminGuardrailDesignationSchema, version)
			const result = await send(
				guardrailPath(row.id) + '/designate?view=summary',
				adminGuardrailSummaryResponseSchema,
				json('POST', { version: checkedVersion }),
				options
			)
			if (
				result.data.id !== row.id ||
				result.data.workspaceId !== row.workspaceId ||
				result.data.ownerUserId !== row.ownerUserId ||
				result.data.designatedVersion !== checkedVersion
			)
				throw new AdminDomainWriteError('unknown', 200)
			return result.data
		},
		async bindGuardrail(
			row: AdminGuardrailSummary,
			scopeType: AdminGuardrailScopeType,
			scopeId: string,
			options: AdminGuardrailsRequestOptions = {}
		): Promise<AdminGuardrailAssignment> {
			const scope = checked(adminGuardrailScopeSchema, { scopeType, scopeId })
			const result = await send(
				guardrailPath(row.id) + '/assignments',
				adminGuardrailAssignmentResponseSchema,
				json('PUT', { scope_type: scope.scopeType, scope_id: scope.scopeId }),
				options
			)
			if (
				result.data.guardrailId !== row.id ||
				result.data.workspaceId !== row.workspaceId ||
				result.data.scopeType !== scope.scopeType ||
				result.data.scopeId !== scope.scopeId
			)
				throw new AdminDomainWriteError('unknown', 200)
			return result.data
		},
		async unbindGuardrail(
			row: AdminGuardrailSummary,
			assignment: AdminGuardrailAssignment,
			options: AdminGuardrailsRequestOptions = {}
		): Promise<boolean> {
			if (
				assignment.guardrailId !== row.id ||
				assignment.workspaceId !== row.workspaceId
			)
				transport.invalidResponse('Unbound guardrail identity differs')
			const scope = checked(adminGuardrailScopeSchema, assignment)
			const path =
				root +
				'/assignments/' +
				scope.scopeType +
				'/' +
				encodeURIComponent(scope.scopeId) +
				'?workspace_id=' +
				encodeURIComponent(checked(adminGuardrailIdSchema, row.workspaceId)) +
				'&expected_guardrail_id=' +
				encodeURIComponent(checked(adminGuardrailIdSchema, row.id))
			const result = await send(
				path,
				adminGuardrailDeleteAssignmentResponseSchema,
				{ method: 'DELETE' },
				options
			)
			return result.removed
		},
	}
}
export type AdminGuardrailsApi = ReturnType<typeof createAdminGuardrailsApi>
