import { z } from 'zod'
import type { RequestOptions } from './api'
import {
	presetCollectionResponseSchema,
	presetIdentitySchema,
	presetMetadataInputSchema,
	presetResponseSchema,
	presetVersionsResponseSchema,
	savePresetVersionInputSchema,
	type PresetCollection,
	type PresetMetadataInput,
	type PresetVersions,
	type RequestPreset,
	type SavePresetVersionInput,
} from './preset-contracts'

export type PresetRequestOptions = RequestOptions & {
	expectedWorkspaceId: string
	expectedOwnerUserId: string
}
type PresetTransport = {
	send<T>(
		path: string,
		schema: z.ZodType<T>,
		init: RequestInit,
		options: RequestOptions
	): Promise<T>
	checkWorkspace(actual: string, options: RequestOptions): void
	invalidResponse(message: string): never
	sanitizeError?(error: unknown): Error
}
export function createPresetsApi(transport: PresetTransport) {
	async function send<T>(
		url: string,
		schema: z.ZodType<T>,
		init: RequestInit,
		options: RequestOptions
	): Promise<T> {
		try {
			return await transport.send(url, schema, init, options)
		} catch (error) {
			throw (
				transport.sanitizeError?.(error) ?? new Error('Preset request failed')
			)
		}
	}
	function scope(options: PresetRequestOptions) {
		presetIdentitySchema.parse(options.expectedWorkspaceId)
		presetIdentitySchema.parse(options.expectedOwnerUserId)
	}
	function check(
		row: RequestPreset,
		options: PresetRequestOptions
	): RequestPreset {
		transport.checkWorkspace(row.workspaceId, options)
		if (row.ownerUserId !== options.expectedOwnerUserId)
			transport.invalidResponse('Server returned another preset owner')
		return row
	}
	function path(id: string) {
		return (
			'/api/user/presets/' + encodeURIComponent(presetIdentitySchema.parse(id))
		)
	}
	function json(method: string, input: unknown): RequestInit {
		return {
			method,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(input),
		}
	}
	return {
		presetCollection: async (
			options: PresetRequestOptions
		): Promise<PresetCollection> => {
			scope(options)
			const result = await send(
				'/api/user/presets',
				presetCollectionResponseSchema,
				{},
				options
			)
			transport.checkWorkspace(result.data.workspaceId, options)
			if (result.data.ownerUserId !== options.expectedOwnerUserId)
				transport.invalidResponse(
					'Server returned another preset collection owner'
				)
			const rows = result.data.presets
			if (
				new Set(rows.map((row) => row.id)).size !== rows.length ||
				new Set(rows.map((row) => row.slug)).size !== rows.length
			)
				transport.invalidResponse('Server returned duplicate presets')
			rows.forEach((row) => check(row, options))
			return result.data
		},
		/** Core saves and automatically designates the new version; the UI must disclose activation. */
		savePresetVersion: async (
			input: SavePresetVersionInput,
			options: PresetRequestOptions
		): Promise<RequestPreset> => {
			scope(options)
			const normalized = savePresetVersionInputSchema.parse(input)
			const result = await send(
				'/api/user/presets',
				presetResponseSchema,
				json('POST', normalized),
				options
			)
			if (result.data.slug !== normalized.slug)
				transport.invalidResponse('Server returned another preset slug')
			if (
				result.data.designatedVersion !== result.data.latestVersion ||
				result.data.status !== 'active'
			)
				transport.invalidResponse(
					'Server did not activate the saved preset version'
				)
			return check(result.data, options)
		},
		presetVersions: async (
			id: string,
			options: PresetRequestOptions
		): Promise<PresetVersions> => {
			scope(options)
			const result = await send(
				path(id) + '/versions',
				presetVersionsResponseSchema,
				{},
				options
			)
			transport.checkWorkspace(result.workspaceId, options)
			if (
				result.presetId !== id ||
				result.ownerUserId !== options.expectedOwnerUserId ||
				new Set(result.data.map((row) => row.id)).size !== result.data.length ||
				new Set(result.data.map((row) => row.version)).size !==
					result.data.length
			)
				transport.invalidResponse('Server returned another preset history')
			return result
		},
		updatePresetMetadata: async (
			id: string,
			input: PresetMetadataInput,
			options: PresetRequestOptions
		): Promise<RequestPreset> => {
			scope(options)
			const result = await send(
				path(id),
				presetResponseSchema,
				json('PATCH', presetMetadataInputSchema.parse(input)),
				options
			)
			if (result.data.id !== id)
				transport.invalidResponse('Server returned another preset')
			return check(result.data, options)
		},
		designatePresetVersion: async (
			id: string,
			version: number,
			options: PresetRequestOptions
		): Promise<RequestPreset> => {
			scope(options)
			z.number().int().positive().safe().parse(version)
			const result = await send(
				path(id) + '/designate',
				presetResponseSchema,
				json('POST', { version }),
				options
			)
			if (result.data.id !== id || result.data.designatedVersion !== version)
				transport.invalidResponse(
					'Server returned another designated preset version'
				)
			return check(result.data, options)
		},
		/** DELETE archives the resource and preserves its versions; it is never a hard deletion. */
		archivePreset: async (
			id: string,
			options: PresetRequestOptions
		): Promise<void> => {
			scope(options)
			await send(
				path(id),
				z.object({ success: z.literal(true) }).strict(),
				{ method: 'DELETE' },
				options
			)
		},
	}
}
export type PresetsApi = ReturnType<typeof createPresetsApi>
