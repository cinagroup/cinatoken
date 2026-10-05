/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import { CinaTokenApiError, createCinaTokenCookieTransport } from '../../api'
import { toolAuditSchema, validToolAuditPage } from './tools-audit'
import {
	toolDetailSchema,
	toolDetailData,
	toolOverviewSchema,
	toolFamilySchema,
	toolProviderSchema,
	toolFieldSchema,
	type ToolDetail,
} from './tools-contracts'
import {
	validToolTarget,
	type ToolFamily,
	type ToolProvider,
} from './tools-domain'
import {
	ToolInputError,
	ToolSubjectError,
	ToolReadError,
	sanitizeToolError,
} from './tools-errors'
import {
	validateToolSave,
	validateToolReveal,
	type ToolSaveInput,
	type ToolRevealInput,
} from './tools-input'
import {
	toolRejectedSchema,
	ToolRejectedError,
	acceptToolRejection,
} from './tools-rejection'
import {
	createToolSubjectGate,
	TOOL_CONSOLE_SUBJECT_HEADER,
	type ToolRequestOptions,
	type ToolBoundOptions,
} from './tools-subject'
import { toolUuid, toolToken, decodeToolCursor } from './tools-token'

const saveResponse = z.object({
	success: z.literal(true),
	data: z
		.object({
			outcome: z.enum(['applied', 'unchanged']),
			auditId: toolUuid.nullable(),
			detail: toolDetailData,
		})
		.refine((value) =>
			value.outcome === 'applied'
				? value.auditId !== null
				: value.auditId === null
		),
})
const revealResponse = z.object({
	success: z.literal(true),
	data: z.object({
		family: toolFamilySchema,
		provider: toolProviderSchema,
		field: toolFieldSchema,
		value: z
			.string()
			.min(1)
			.max(4096)
			.refine(
				(value) =>
					value.length <= 4096 &&
					value.trim() === value &&
					!/[\p{Cc}\p{Cf}]/u.test(value)
			),
		version: toolToken,
		auditId: toolUuid,
		expiresInSeconds: z.literal(60),
	}),
})
function invalid(): never {
	throw new CinaTokenApiError(
		'Tools response is invalid',
		200,
		'invalid-response'
	)
}
function path(family: ToolFamily, provider?: ToolProvider): string {
	if (
		!toolFamilySchema.safeParse(family).success ||
		(provider !== undefined && !validToolTarget(family, provider))
	)
		throw new ToolInputError()
	const base = '/api/admin/config/tools/' + family
	return provider === undefined ? base : base + '/providers/' + provider
}
const only = (options: ToolRequestOptions) => ({
	signal: options.signal,
	timeoutMs: options.timeoutMs,
})
const json = (body: object, subject: string): RequestInit => ({
	method: 'POST',
	headers: {
		'Content-Type': 'application/json',
		[TOOL_CONSOLE_SUBJECT_HEADER]: subject,
	},
	body: JSON.stringify(body),
})
export function createAdminToolsApi(request: typeof fetch = fetch) {
	const { send } = createCinaTokenCookieTransport(request),
		verify = createToolSubjectGate(request)
	async function checkCapability(
		detail: ToolDetail,
		kind: 'save' | 'reveal',
		options: ToolBoundOptions
	): Promise<void> {
		let current: ToolDetail
		try {
			current = (
				await send(
					path(detail.family, detail.provider) + '/detail',
					toolDetailSchema,
					{},
					only(options)
				)
			).data
			if (
				current.family !== detail.family ||
				current.provider !== detail.provider
			)
				invalid()
		} catch (error) {
			throw new ToolReadError(sanitizeToolError(error))
		}
		const allowed =
			kind === 'save'
				? current.capabilities.can_write && current.familyState.editable
				: current.capabilities.can_reveal
		if (!allowed) throw new ToolSubjectError()
	}
	return {
		verifyToolSubject: verify,
		async adminToolsOverview(options: ToolRequestOptions = {}) {
			try {
				return (
					await send(
						'/api/admin/config/tools/overview',
						toolOverviewSchema,
						{},
						only(options)
					)
				).data
			} catch (error) {
				throw sanitizeToolError(error)
			}
		},
		async adminToolDetail(
			family: ToolFamily,
			provider: ToolProvider,
			options: ToolRequestOptions = {}
		) {
			try {
				const value = (
					await send(
						path(family, provider) + '/detail',
						toolDetailSchema,
						{},
						only(options)
					)
				).data
				if (value.family !== family || value.provider !== provider) invalid()
				return value
			} catch (error) {
				throw sanitizeToolError(error)
			}
		},
		async saveAdminTool(
			detail: ToolDetail,
			input: ToolSaveInput,
			options: ToolBoundOptions
		) {
			const checked = validateToolSave(detail, input)
			try {
				await verify(options)
				await checkCapability(detail, 'save', options)
				const subject = await verify(options)
				const result = await send(
					path(detail.family, detail.provider) + '/save',
					z.union([saveResponse, toolRejectedSchema]),
					json(checked, subject),
					only(options),
					undefined,
					acceptToolRejection
				)
				if (!result.success) {
					if (result.code === 'console_subject_mismatch')
						throw new ToolSubjectError()
					throw new ToolRejectedError(result.code)
				}
				const value = result.data
				if (
					value.detail.family !== detail.family ||
					value.detail.provider !== detail.provider
				)
					invalid()
				return value
			} catch (error) {
				throw sanitizeToolError(error)
			}
		},
		async revealAdminTool(
			detail: ToolDetail,
			input: ToolRevealInput,
			options: ToolBoundOptions
		) {
			const checked = validateToolReveal(detail, input)
			try {
				await verify(options)
				await checkCapability(detail, 'reveal', options)
				const subject = await verify(options)
				const result = await send(
					path(detail.family, detail.provider) + '/reveal',
					z.union([revealResponse, toolRejectedSchema]),
					json(checked, subject),
					only(options),
					undefined,
					acceptToolRejection
				)
				if (!result.success) {
					if (result.code === 'console_subject_mismatch')
						throw new ToolSubjectError()
					throw new ToolRejectedError(result.code)
				}
				const value = result.data
				if (
					value.family !== detail.family ||
					value.provider !== detail.provider ||
					value.field !== checked.field ||
					value.version !== detail.version
				)
					invalid()
				return value
			} catch (error) {
				throw sanitizeToolError(error)
			}
		},
		async adminToolAudit(
			family: ToolFamily,
			before: string | null,
			options: ToolRequestOptions = {}
		) {
			const boundary = before === null ? null : decodeToolCursor(before, family)
			if (before !== null && !boundary) throw new ToolInputError()
			const params = new URLSearchParams({ limit: '20' })
			if (before !== null) params.set('before', before)
			try {
				const value = (
					await send(
						path(family) + '/audit?' + params.toString(),
						toolAuditSchema,
						{},
						only(options)
					)
				).data
				if (!validToolAuditPage(value, family, boundary)) invalid()
				return value
			} catch (error) {
				throw sanitizeToolError(error)
			}
		},
	}
}
export type AdminToolsApi = ReturnType<typeof createAdminToolsApi>
