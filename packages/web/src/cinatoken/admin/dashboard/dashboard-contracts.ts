/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import { bucketCoordinate } from './dashboard-trend'

const count = z.number().int().nonnegative().finite()
const amount = z.number().finite()
const percent = z.number().min(0).max(100).finite()
const shortText = z.string().min(1).max(512)
const nullableText = z.string().max(512).nullable()
const isoUtc = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/)
	.refine((value) => Number.isFinite(Date.parse(value)))
const businessBucket = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2})?$/)
	.refine((value) => Number.isFinite(bucketCoordinate(value)))

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
	bucket: businessBucket,
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

const timing = z.number().nonnegative().finite().nullable()
const period = z.object({
	requests: count,
	success: count,
	errors: count,
	incomplete: count,
	cancelled: count,
	charged: amount,
	metered: amount,
	standard: amount,
	errorCost: amount,
	failoverRequests: count,
	failoverSamples: count,
	attemptsSamples: count,
	avgAttempts: timing,
	ttftSamples: count,
	ttftP50: timing,
	ttftP95: timing,
	latencySamples: count,
	latencyP50: timing,
	latencyP95: timing,
})
const sqlUtc = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
	.refine((value) => {
		const date = new Date(value.replace(' ', 'T') + 'Z')
		return (
			Number.isFinite(date.getTime()) &&
			date.toISOString().slice(0, 19).replace('T', ' ') === value
		)
	})
const operations = z.object({
	current: period,
	previous: period,
	window: z.strictObject({
		startDate: sqlUtc,
		endDate: sqlUtc,
		previousStart: sqlUtc,
		previousEnd: sqlUtc,
	}),
	providers: z
		.array(
			z.strictObject({
				id: z.string().max(512),
				name: nullableText,
				requests: count,
				errors: count,
				affectedUsers: count,
			})
		)
		.max(5),
	errorCategories: z
		.array(
			z.strictObject({
				category: z.enum([
					'rate_limit',
					'timeout',
					'auth',
					'upstream',
					'request',
					'other',
				]),
				count,
			})
		)
		.max(6),
})

// Project only displayed summaries; keep nested contracts and log privacy strict.
export const dashboardStatsSchema = z.object({
	operations: operations.optional(),
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
	timeseries: z
		.array(timeseriesBucket)
		.max(200)
		.refine(
			(rows) => new Set(rows.map((row) => row.bucket)).size === rows.length
		),
	granularity: z.enum(['hour', 'day']),
	recentLogs: z.array(recentSummary).max(8),
	recentErrors: z.array(recentSummary).max(8),
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
