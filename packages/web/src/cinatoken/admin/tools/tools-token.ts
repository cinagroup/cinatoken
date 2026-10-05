/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import { toolFamilies, type ToolFamily } from './tools-domain'

export const toolUuid = z
	.string()
	.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u)
export const toolToken = z
	.string()
	.min(1)
	.max(2048)
	.regex(/^[A-Za-z0-9_-]+$/u)
export const toolTime = z
	.string()
	.refine(
		(value) =>
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(value) &&
			Number.isFinite(Date.parse(value)) &&
			new Date(value).toISOString().slice(0, 23) === value.slice(0, 23)
	)
const keys = {
	'web-search': [
		'BILLING_CURRENCY',
		'WEB_SEARCH_ACTIVE',
		'WEB_SEARCH_API_KEY',
		'WEB_SEARCH_CATALOG',
		'WEB_SEARCH_COST',
		'WEB_SEARCH_PROVIDER',
	],
	'web-fetch': [
		'BILLING_CURRENCY',
		'WEB_FETCH_ACTIVE',
		'WEB_FETCH_API_KEY',
		'WEB_FETCH_CATALOG',
		'WEB_FETCH_COST',
		'WEB_FETCH_PROVIDER',
	],
	'web-deep-search': [
		'BILLING_CURRENCY',
		'WEB_DEEP_SEARCH_ACTIVE',
		'WEB_DEEP_SEARCH_CATALOG',
	],
	'ai-detection': [
		'AI_DETECTION_ACTIVE',
		'AI_DETECTION_CATALOG',
		'BILLING_CURRENCY',
	],
} as const
export function encodeToolToken(value: unknown): string {
	const bytes = new TextEncoder().encode(JSON.stringify(value))
	return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/u, '')
}
function decode(raw: string): unknown {
	if (!toolToken.safeParse(raw).success)
		throw new TypeError('Invalid Tools token')
	const bytes = Uint8Array.from(
		atob(raw.replaceAll('-', '+').replaceAll('_', '/')),
		(c) => c.charCodeAt(0)
	)
	return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
}
const version = z
	.object({
		v: z.literal(1),
		family: z.enum(toolFamilies),
		readSet: z.array(
			z
				.object({
					key: z.string(),
					revision: z.union([toolUuid, z.literal('legacy'), z.null()]),
				})
				.strict()
		),
	})
	.strict()
export function validToolVersion(raw: string, family: ToolFamily): boolean {
	try {
		const value = version.parse(decode(raw))
		return (
			value.family === family &&
			value.readSet.length === keys[family].length &&
			value.readSet.every((row, i) => row.key === keys[family][i]) &&
			encodeToolToken(value) === raw
		)
	} catch {
		return false
	}
}
const cursor = z
	.object({
		v: z.literal(1),
		family: z.enum(toolFamilies),
		created_at: toolTime,
		id: toolUuid,
	})
	.strict()
export type ToolCursor = z.infer<typeof cursor>
export function decodeToolCursor(
	raw: string,
	family: ToolFamily
): ToolCursor | null {
	try {
		const value = cursor.parse(decode(raw))
		return value.family === family && encodeToolToken(value) === raw
			? value
			: null
	} catch {
		return null
	}
}
