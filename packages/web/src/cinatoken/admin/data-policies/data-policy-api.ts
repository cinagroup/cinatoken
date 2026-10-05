/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z as schema } from 'zod'
import {
	createAdminDomainTransport,
	type AdminDomainRequestOptions,
} from '../domain-transport'
import { AdminDomainWriteError } from '../domain-write-recovery'
import {
	dataPolicyAuditResponseSchema,
	dataPolicyListResponseSchema,
	dataPolicyRouteTargetIdSchema,
	dataPolicyUpsertInputSchema,
	dataPolicyUpsertResponseSchema,
	type DataPolicyAudit,
	type DataPolicyListRow,
	type DataPolicyUpsertInput,
} from './data-policy-contracts'

export type DataPolicyRequestOptions = AdminDomainRequestOptions & {
	expectedPolicy?: Pick<
		DataPolicyListRow,
		| 'route_target_id'
		| 'current_subject_fingerprint'
		| 'current_policy_fingerprint'
	>
}
export type DataPolicyAdminTransport = {
	send<T>(
		path: string,
		schema: schema.ZodType<T>,
		init: RequestInit,
		options: DataPolicyRequestOptions
	): Promise<T>
	invalidResponse(message: string): never
	sanitizeError(error: unknown): Error
}

const root = '/api/admin/data-policies'

/** Same-origin Console Cookie transport. No workspace or Bearer context is accepted. */
export function createDataPoliciesApi(transport: DataPolicyAdminTransport) {
	const domainTransport = createAdminDomainTransport(transport, 'data-policies')
	function validated<T>(schema: schema.ZodType<T>, value: unknown): T {
		try {
			return schema.parse(value)
		} catch (error) {
			throw transport.sanitizeError(error)
		}
	}
	function routePath(routeTargetId: string): string {
		const id = validated(dataPolicyRouteTargetIdSchema, routeTargetId)
		return root + '/' + encodeURIComponent(id)
	}
	async function send<T>(
		path: string,
		schema: schema.ZodType<T>,
		init: RequestInit,
		options: DataPolicyRequestOptions
	): Promise<T> {
		try {
			options.signal?.throwIfAborted()
			const result = await domainTransport.send(path, schema, init, options)
			options.signal?.throwIfAborted()
			return result
		} catch (error) {
			if (error instanceof AdminDomainWriteError) throw error
			throw transport.sanitizeError(error)
		}
	}
	return {
		verifyAdminDomainSubject: domainTransport.verifyAdminDomainSubject,
		async dataPolicyListing(options: DataPolicyRequestOptions = {}) {
			const result = await send(root, dataPolicyListResponseSchema, {}, options)
			if (
				new Set(result.data.map((row) => row.route_target_id)).size !==
				result.data.length
			)
				transport.invalidResponse('Duplicate route target identities')
			return { data: result.data, canWrite: result.canWrite === true }
		},
		async dataPolicyList(
			options: DataPolicyRequestOptions = {}
		): Promise<DataPolicyListRow[]> {
			return (await this.dataPolicyListing(options)).data
		},
		async dataPolicyAudit(
			routeTargetId: string,
			options: DataPolicyRequestOptions = {}
		): Promise<DataPolicyAudit[]> {
			const id = validated(dataPolicyRouteTargetIdSchema, routeTargetId)
			const result = await send(
				routePath(id) + '/audit',
				dataPolicyAuditResponseSchema,
				{},
				options
			)
			if (
				new Set(result.data.map((row) => row.id)).size !== result.data.length ||
				result.data.some(
					(row) =>
						(row.route_target_id !== null && row.route_target_id !== id) ||
						(row.snapshot !== null &&
							'route_target_id' in row.snapshot &&
							row.snapshot.route_target_id !== id)
				)
			)
				transport.invalidResponse(
					'Audit collection belongs to another route target'
				)
			return result.data
		},
		async upsertDataPolicy(
			routeTargetId: string,
			input: DataPolicyUpsertInput,
			options: DataPolicyRequestOptions = {}
		): Promise<void> {
			const id = validated(dataPolicyRouteTargetIdSchema, routeTargetId)
			const payload = validated(dataPolicyUpsertInputSchema, input)
			const expected = schema
				.object({
					route_target_id: schema.literal(id),
					current_subject_fingerprint: schema.string().regex(/^[0-9a-f]{64}$/),
					current_policy_fingerprint: schema
						.string()
						.regex(/^[0-9a-f]{64}$/)
						.nullable(),
				})
				.safeParse(options.expectedPolicy)
			if (!expected.success) throw new AdminDomainWriteError('subject', 400)
			const result = await send(
				routePath(id),
				dataPolicyUpsertResponseSchema,
				{
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						...payload,
						expected_subject_fingerprint:
							expected.data.current_subject_fingerprint,
						expected_policy_fingerprint:
							expected.data.current_policy_fingerprint,
					}),
				},
				options
			)
			if (
				result.data.route_target_id !== id ||
				result.data.status !== payload.status ||
				result.data.subject_fingerprint !==
					expected.data.current_subject_fingerprint ||
				result.data.retention_days !== payload.retention_days ||
				result.data.training_allowed !== payload.training_allowed ||
				result.data.zdr_supported !== payload.zdr_supported ||
				result.data.evidence_url !== payload.evidence_url ||
				result.data.verified_by !==
					(payload.status === 'verified'
						? 'console:cinaauth:' + options.expectedConsoleSubject
						: null) ||
				(payload.status === 'verified'
					? result.data.verified_at === null
					: result.data.verified_at !== null) ||
				result.data.invalidated_at !== null ||
				result.data.invalidation_reason !== null ||
				(result.data.expires_at === null
					? null
					: new Date(result.data.expires_at).toISOString()) !==
					payload.expires_at
			)
				throw new AdminDomainWriteError('unknown', 200)
		},
	}
}
export type DataPoliciesApi = ReturnType<typeof createDataPoliciesApi>
