/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import { defaultParseSearch } from '@tanstack/react-router'
import { PublicCatalogError } from '../catalog-api'
import {
	catalogDetailSchema,
	catalogModelsSchema,
	catalogProvidersSchema,
	catalogStatsRangeSchema,
	catalogStatsSchema,
} from '../catalog-contracts'
import { validateStatsSearch } from '../catalog-search'
import { PUBLIC_LOCALES } from './public-location'
import { classifyPublicRoute, hasPublicControls } from './public-route'

const instant = z.number().int().nonnegative().max(8_640_000_000_000_000)
const errorCode = z.enum([
	'http',
	'invalid-response',
	'network',
	'timeout',
	'cancelled',
])
const safeRetryAfter = z
	.string()
	.max(128)
	.refine(
		(value) =>
			/^\d{1,5}$/.test(value) ||
			(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
				value
			) &&
				Number.isFinite(Date.parse(value)))
	)
export const publicErrorSchema = z
	.object({
		code: errorCode,
		status: z.number().int().min(0).max(599),
		retryAfter: safeRetryAfter.nullable(),
	})
	.strict()
export type SafePublicError = z.infer<typeof publicErrorSchema>

function resultSchema<T extends z.ZodType>(data: T) {
	return z.discriminatedUnion('status', [
		z
			.object({ status: z.literal('success'), data, observedAt: instant })
			.strict(),
		z
			.object({
				status: z.literal('error'),
				error: publicErrorSchema,
				observedAt: instant,
			})
			.strict(),
	])
}

export const publicSnapshotSchema = z.discriminatedUnion('kind', [
	z
		.object({
			kind: z.literal('models'),
			result: resultSchema(catalogModelsSchema),
		})
		.strict(),
	z
		.object({
			kind: z.literal('chat-models'),
			result: resultSchema(catalogModelsSchema),
		})
		.strict(),
	z
		.object({
			kind: z.literal('providers'),
			result: resultSchema(catalogProvidersSchema),
		})
		.strict(),
	z
		.object({
			kind: z.literal('model'),
			vendor: z.string().min(1).max(80),
			slug: z.string().min(1).max(256),
			result: resultSchema(catalogDetailSchema),
		})
		.strict(),
	z
		.object({
			kind: z.literal('stats'),
			range: catalogStatsRangeSchema,
			result: resultSchema(catalogStatsSchema),
		})
		.strict(),
])
export type PublicSnapshot = z.infer<typeof publicSnapshotSchema>

export const publicBootstrapSchema = z
	.object({
		version: z.literal(1),
		locale: z.enum(PUBLIC_LOCALES),
		pathname: z.string().min(1).max(4_096),
		search: z.string().max(65_536),
		status: z.union([z.literal(200), z.literal(404), z.literal(503)]),
		records: z.array(publicSnapshotSchema).max(1),
	})
	.strict()
	.superRefine((value, context) => {
		const fail = () =>
			context.addIssue({
				code: 'custom',
				message: 'Invalid public snapshot scope',
			})
		if (
			!value.pathname.startsWith('/') ||
			value.pathname.startsWith('//') ||
			/[?#\\\s]/.test(value.pathname) ||
			hasPublicControls(value.pathname)
		)
			fail()
		if (
			value.search &&
			(!value.search.startsWith('?') ||
				value.search.includes('#') ||
				hasPublicControls(value.search))
		)
			fail()
		const route = classifyPublicRoute(value.pathname, value.locale)
		const record = value.records[0]
		if (route.kind === 'home' || route.kind === 'not-found') {
			if (record || value.status !== (route.kind === 'home' ? 200 : 404)) fail()
			return
		}
		let expected = route.kind
		if (route.kind === 'compare') expected = 'models'
		if (route.kind === 'chat') expected = 'chat'
		const kind = route.kind === 'chat' ? 'chat-models' : expected
		if (
			!record ||
			(route.kind === 'rankings' || route.kind === 'benchmarks'
				? record.kind !== 'stats'
				: record.kind !== kind)
		) {
			fail()
			return
		}
		if (record.kind === 'model') {
			if (
				route.kind !== 'model' ||
				record.vendor !== route.vendor ||
				record.slug !== route.slug
			)
				fail()
			if (
				record.result.status === 'success' &&
				(record.result.data.data.vendor.toLowerCase() !==
					record.vendor.toLowerCase() ||
					record.result.data.data.slug !== record.slug)
			)
				fail()
		}
		if (record.kind === 'stats') {
			const range = validateStatsSearch(defaultParseSearch(value.search)).range
			if (
				record.range !== range ||
				(record.result.status === 'success' &&
					record.result.data.range !== record.range)
			)
				fail()
		}
		const status =
			record.result.status === 'success'
				? 200
				: failureStatus(record.result.error, record.kind === 'model')
		if (value.status !== status) fail()
	})

export type PublicBootstrap = z.infer<typeof publicBootstrapSchema>

export const PUBLIC_BOOTSTRAP_MAX_BYTES = 16 * 1024 * 1024

function assertPublicBootstrapSize(value: string): void {
	if (new TextEncoder().encode(value).byteLength > PUBLIC_BOOTSTRAP_MAX_BYTES)
		throw new TypeError('Public snapshot is too large')
}

export function safePublicError(error: unknown): SafePublicError {
	if (error instanceof PublicCatalogError) {
		const parsed = publicErrorSchema.safeParse({
			code: error.code,
			status: error.status,
			retryAfter: error.retryAfter,
		})
		if (parsed.success) return parsed.data
	}
	return { code: 'network', status: 0, retryAfter: null }
}

export function failureStatus(
	error: SafePublicError,
	modelDetail: boolean
): 404 | 503 {
	return modelDetail && error.code === 'http' && error.status === 404
		? 404
		: 503
}

export function serializePublicBootstrap(bootstrap: PublicBootstrap): string {
	const serialized = JSON.stringify(publicBootstrapSchema.parse(bootstrap))
		.replace(/</g, '\\u003c')
		.replace(/>/g, '\\u003e')
		.replace(/&/g, '\\u0026')
		.replace(/\u2028/g, '\\u2028')
		.replace(/\u2029/g, '\\u2029')
	assertPublicBootstrapSize(serialized)
	return serialized
}

export function parsePublicBootstrap(value: string): PublicBootstrap {
	assertPublicBootstrapSize(value)
	return publicBootstrapSchema.parse(JSON.parse(value) as unknown)
}
