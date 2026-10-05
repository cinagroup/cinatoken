/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'

const count = z.number().int().nonnegative().finite()
const amount = z.number().finite()
const percent = z.number().min(0).max(100).finite()
const shortText = z.string().min(1).max(512)
const nullableText = z.string().max(512).nullable()
const isoUtc = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/)
	.refine((value) => Number.isFinite(Date.parse(value)))
const bucketUtc = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2})?$/)
	.refine((value) => Number.isFinite(Date.parse(value.replace(' ', 'T') + 'Z')))

const recentSummary = z.strictObject({
	id: shortText,
	model_id: nullableText,
	provider_id: nullableText,
	provider_name: nullableText,
	status: z.enum(['success', 'error', 'incomplete', 'cancelled']),
	created_at: isoUtc,
})

const distribution = z.strictObject({
	model_id: shortText,
	request_count: count,
	input_tokens: count,
	output_tokens: count,
	total_tokens: count,
	charged_cost: amount,
	metered_cost: amount,
	standard_cost: amount,
})

const topUser = z.strictObject({
	user_email: z.string().min(1).max(320),
	request_count: count,
	input_tokens: count,
	output_tokens: count,
	total_tokens: count,
	charged_cost: amount,
	metered_cost: amount,
	standard_cost: amount,
})

const timeseriesBucket = z.strictObject({
	bucket: bucketUtc,
	request_count: count,
	input_tokens: count,
	output_tokens: count,
	cache_read_tokens: count,
	cache_write_tokens: count,
	total_tokens: count,
	charged_cost: amount,
	avg_latency_ms: z.number().nonnegative().finite().nullable(),
	cache_hit_rate: percent,
})

export const dashboardStatsSchema = z.strictObject({
	gateway: z.strictObject({
		activeKeysCount: count,
		keysTotal: count,
		keysActive: count,
		accountsTotal: count,
		accountsActive: count,
		todayRequestsCount: count,
		todayCost: amount,
		todayTokens: count,
		errorRate: percent,
	}),
	kpi: z.strictObject({
		totalRequests: count,
		successRate: percent,
		totalCost: amount,
		meteredCost: amount,
		standardCost: amount,
		activeUsers: count,
		errorRate: percent,
		inputTokens: count,
		outputTokens: count,
		cacheReadTokens: count,
		cacheWriteTokens: count,
		totalTokens: count,
		avgLatencyMs: z.number().nonnegative().finite().nullable(),
		rpm: count,
		tpm: count,
	}),
	modelDistribution: z.array(distribution).max(10),
	topUsers: z.array(topUser).max(12),
	timeseries: z.array(timeseriesBucket).max(200),
	granularity: z.enum(['hour', 'day']),
	recentLogs: z.array(recentSummary).max(5),
	recentErrors: z.array(recentSummary).max(5),
})

export const dashboardStatsResponseSchema = z.strictObject({
	success: z.literal(true),
	data: dashboardStatsSchema,
})

export type DashboardStats = z.infer<typeof dashboardStatsSchema>

export type DashboardDisplayConfig = {
	businessTimezone: string
	timezoneSource: 'configured' | 'legacy' | 'missing' | 'invalid'
	billingCurrency: 'USD' | 'CNY'
	currencySource: 'configured' | 'missing'
}

export type DashboardSnapshot = {
	stats: DashboardStats
	displayConfig: DashboardDisplayConfig
}

export class DashboardCurrencyUnavailableError extends Error {
	constructor() {
		super('Dashboard billing currency cannot be verified')
		this.name = 'DashboardCurrencyUnavailableError'
	}
}
