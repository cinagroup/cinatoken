/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { z } from 'zod'
import {
	createAdminDomainTransport,
	type AdminDomainRequestOptions,
	type AdminDomainTransport,
} from '../domain-transport'
import { AdminDomainWriteError } from '../domain-write-recovery'
import {
	adminPresetDesignationSchema,
	adminPresetIdSchema,
	adminPresetMetadataPatchSchema,
	adminPresetSummariesResponseSchema,
	adminPresetSummaryResponseSchema,
	adminPresetVersionSummariesResponseSchema,
	type AdminPresetMetadataPatch,
	type AdminPresetSummary,
	type AdminPresetVersionSummary,
} from './presets-contracts'

export type AdminPresetsRequestOptions = AdminDomainRequestOptions & {
	/** Read scope of the selected row; it is never persisted in recovery storage. */
	expectedPreset?: Pick<
		AdminPresetSummary,
		'id' | 'workspaceId' | 'ownerUserId' | 'slug'
	>
}
export type AdminPresetsTransport = AdminDomainTransport

const root = '/api/admin/presets'
const json = (method: string, value: unknown): RequestInit => ({
	method,
	headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify(value),
})

/** Same-origin Console Cookie transport; no workspace or Bearer context. */
export function createAdminPresetsApi(transport: AdminPresetsTransport) {
	const bound = createAdminDomainTransport(transport, 'presets')
	function sameScope(
		row: AdminPresetSummary,
		options: AdminPresetsRequestOptions
	): boolean {
		const expected = options.expectedPreset
		return (
			!expected ||
			(row.id === expected.id &&
				row.workspaceId === expected.workspaceId &&
				row.ownerUserId === expected.ownerUserId &&
				row.slug === expected.slug)
		)
	}
	function validated<T>(schema: z.ZodType<T>, value: unknown): T {
		try {
			return schema.parse(value)
		} catch (error) {
			throw transport.sanitizeError(error)
		}
	}
	function presetPath(id: string): string {
		return root + '/' + encodeURIComponent(validated(adminPresetIdSchema, id))
	}
	async function send<T>(
		path: string,
		schema: z.ZodType<T>,
		init: RequestInit,
		options: AdminPresetsRequestOptions
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
		async listPresets(
			options: AdminPresetsRequestOptions = {}
		): Promise<AdminPresetSummary[]> {
			const result = await send(
				root + '/summaries',
				adminPresetSummariesResponseSchema,
				{},
				options
			)
			if (
				result.count !== result.data.length ||
				new Set(result.data.map((row) => row.id)).size !== result.data.length
			)
				transport.invalidResponse(
					'Preset collection count or identities differ'
				)
			return result.data
		},
		async listPresetVersions(
			id: string,
			options: AdminPresetsRequestOptions = {}
		): Promise<AdminPresetVersionSummary[]> {
			const checkedId = validated(adminPresetIdSchema, id)
			const result = await send(
				presetPath(checkedId) + '/version-summaries',
				adminPresetVersionSummariesResponseSchema,
				{},
				options
			)
			const versions = result.data.versions
			if (
				result.data.presetId !== checkedId ||
				result.data.total !== versions.length ||
				new Set(versions.map((row) => row.id)).size !== versions.length ||
				new Set(versions.map((row) => row.version)).size !== versions.length
			)
				transport.invalidResponse('Preset version collection differs')
			return versions
		},
		async patchPreset(
			id: string,
			patch: AdminPresetMetadataPatch,
			options: AdminPresetsRequestOptions = {}
		): Promise<AdminPresetSummary> {
			const checkedId = validated(adminPresetIdSchema, id)
			const body = validated(adminPresetMetadataPatchSchema, patch)
			const result = await send(
				presetPath(checkedId) + '?view=summary',
				adminPresetSummaryResponseSchema,
				json('PATCH', body),
				options
			)
			if (
				!result.data ||
				result.data.id !== checkedId ||
				!sameScope(result.data, options) ||
				(Object.keys(body) as Array<keyof typeof body>).some(
					(key) => result.data?.[key] !== body[key]
				)
			)
				throw new AdminDomainWriteError('unknown', 200)
			return result.data
		},
		async designatePreset(
			id: string,
			version: number,
			options: AdminPresetsRequestOptions = {}
		): Promise<AdminPresetSummary> {
			const checkedId = validated(adminPresetIdSchema, id)
			const checkedVersion = validated(adminPresetDesignationSchema, version)
			const result = await send(
				presetPath(checkedId) + '/designate?view=summary',
				adminPresetSummaryResponseSchema,
				json('POST', { version: checkedVersion }),
				options
			)
			if (
				!result.data ||
				result.data.id !== checkedId ||
				!sameScope(result.data, options) ||
				result.data.designatedVersion !== checkedVersion
			)
				throw new AdminDomainWriteError('unknown', 200)
			return result.data
		},
	}
}
export type AdminPresetsApi = ReturnType<typeof createAdminPresetsApi>
