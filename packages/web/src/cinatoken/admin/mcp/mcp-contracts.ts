/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import {
	parseMcpPricingRule,
	type McpPricingRule,
} from '@octafuse/core/mcp/pricing'

export type { McpPricingRule }
export const mcpIdSchema = z
	.string()
	.min(1)
	.max(600)
	.refine(
		(value) =>
			value !== '.' &&
			value !== '..' &&
			value.trim() === value &&
			!/[\p{Cc}\p{Cf}]/u.test(value)
	)
export const mcpSlugSchema = z
	.string()
	.min(1)
	.max(40)
	.regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u)
	.refine((value) => value !== 'builtin' && value.trim() === value)
export const mcpPricingSchema = z
	.unknown()
	.transform((raw, context): McpPricingRule => {
		try {
			return parseMcpPricingRule(raw)
		} catch {
			context.addIssue({ code: 'custom', message: 'Invalid MCP pricing' })
			return z.NEVER
		}
	})
const text = z.string().max(32_768)
const nullable = text.nullable()
const count = z.number().int().nonnegative().safe()
const metadata = z.string().max(2_000_000).nullable().optional()
export const mcpServerSchema = z.object({
	id: mcpIdSchema,
	slug: mcpSlugSchema,
	name: z.string().min(1).max(120),
	description: z.string().max(2_000).nullable(),
	status: z.enum(['active', 'disabled']),
	urlMasked: z.string().max(20_000),
	authHeaderNames: z.array(z.string().min(1).max(256)).max(20),
	pricing: mcpPricingSchema.nullable(),
	timeoutMs: z.number().int().min(1_000).max(120_000),
	maxResponseBytes: z.number().int().min(1_000).max(8_000_000),
	serverInfo: metadata,
	lastSyncedAt: nullable,
	// Stored upstream failures can embed credentials or URLs; only their presence is public UI state.
	lastSyncError: nullable.transform((value) =>
		value ? 'MCP synchronization failed' : value
	),
	lastSyncSummary: metadata,
	createdAt: z.string().max(80).optional(),
	updatedAt: z.string().max(80).optional(),
})
export const mcpServerSummarySchema = mcpServerSchema.extend({
	enabledCount: count,
	pendingCount: count,
})
export const mcpCatalogItemSchema = z.object({
	id: mcpIdSchema,
	serverId: mcpIdSchema,
	kind: z.enum(['tool', 'prompt', 'resource']),
	upstreamKey: text.min(1),
	exposedName: text.min(1),
	definition: z.unknown().refine((value) => value !== undefined),
	pendingDefinition: z
		.unknown()
		.refine((value) => value !== undefined)
		.nullable(),
	reviewState: z.enum(['none', 'new', 'changed']),
	status: z.enum(['enabled', 'disabled', 'removed']),
	pricing: mcpPricingSchema.nullable(),
	pricingState: z.enum(['inherit', 'override', 'invalid']).optional(),
	syncedAt: z.string().max(80).optional(),
})
export const mcpServerDetailSchema = z.object({
	server: mcpServerSchema,
	items: z.array(mcpCatalogItemSchema).max(25_000),
})
export const mcpSyncSummarySchema = z.object({
	added: z.array(text).max(25_000),
	changed: z.array(text).max(25_000),
	removed: z.array(text).max(25_000),
	unchanged: count,
})
export const mcpConnectionTestSchema = z.object({
	ok: z.literal(true),
	protocolVersion: z.string().min(1).max(80),
	serverInfo: z.unknown(),
	counts: z.object({ tools: count, prompts: count, resources: count }),
})
export const mcpSecretsSchema = z.object({
	url: z.string().min(1).max(20_000),
	authHeaders: z
		.record(z.string().min(1).max(256), z.string().max(4_096))
		.refine((value) => Object.keys(value).length <= 20),
})
export const mcpListResponseSchema = z.object({
	success: z.literal(true),
	data: z.array(mcpServerSummarySchema).max(2_000),
})
export const mcpDetailResponseSchema = z.object({
	success: z.literal(true),
	data: mcpServerDetailSchema,
})
export const mcpCreateResponseSchema = z.object({
	success: z.literal(true),
	data: z.object({ id: mcpIdSchema, slug: mcpSlugSchema }),
})
export const mcpIdResponseSchema = z.object({
	success: z.literal(true),
	data: z.object({ id: mcpIdSchema }),
})
export const mcpDeleteResponseSchema = z
	.object({ success: z.literal(true) })
	.strict()
export const mcpStatusResponseSchema = z.object({
	success: z.literal(true),
	data: z.object({ updated: count }),
})
export const mcpSyncResponseSchema = z.object({
	success: z.literal(true),
	data: mcpSyncSummarySchema,
})
export const mcpTestResponseSchema = z.object({
	success: z.literal(true),
	data: mcpConnectionTestSchema,
})
export const mcpSecretsResponseSchema = z.object({
	success: z.literal(true),
	data: mcpSecretsSchema,
})
export type McpServer = z.infer<typeof mcpServerSchema>
export type McpServerSummary = z.infer<typeof mcpServerSummarySchema>
export type McpCatalogItem = z.infer<typeof mcpCatalogItemSchema>
export type McpServerDetail = z.infer<typeof mcpServerDetailSchema>
export type McpSyncSummary = z.infer<typeof mcpSyncSummarySchema>
export type McpConnectionTest = z.infer<typeof mcpConnectionTestSchema>
export type McpSecrets = z.infer<typeof mcpSecretsSchema>
