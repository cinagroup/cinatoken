/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'

export const rateLimitWriteSchema = z
	.object({ rpm: z.number().int().nonnegative().safe() })
	.strict()
	.nullable()
export type RateLimit = z.infer<typeof rateLimitWriteSchema>
export type RateLimitMode = 'unchanged' | 'unlimited' | 'limited'
/** Missing, malformed or future shapes remain unknown instead of masquerading as unlimited. */
export const rateLimitReadSchema = z
	.unknown()
	.transform((raw): RateLimit | undefined => {
		if (raw === null) return null
		if (
			raw &&
			typeof raw === 'object' &&
			!Array.isArray(raw) &&
			Object.keys(raw).length === 0
		)
			return null
		const parsed = rateLimitWriteSchema.safeParse(raw)
		return parsed.success ? parsed.data : undefined
	})
	.optional()
export function rateLimitRpmInput(value: RateLimit | undefined): string {
	return value ? String(value.rpm) : ''
}
export function rateLimitEquals(
	actual: RateLimit | undefined,
	expected: RateLimit | undefined
): boolean {
	if (actual === undefined || expected === undefined) return actual === expected
	if (actual === null || expected === null) return actual === expected
	return actual.rpm === expected.rpm
}
export function rateLimitPatch(
	before: RateLimit | undefined,
	mode: RateLimitMode = 'unchanged',
	raw = ''
): RateLimit | undefined {
	if (mode === 'unchanged') return undefined
	let next: RateLimit
	if (mode === 'unlimited') next = null
	else if (mode === 'limited' && /^\d{1,16}$/u.test(raw.trim())) {
		const parsed = rateLimitWriteSchema.safeParse({ rpm: Number(raw.trim()) })
		if (!parsed.success) throw new TypeError('Invalid RPM limit')
		next = parsed.data
	} else throw new TypeError('Invalid RPM limit')
	return rateLimitEquals(before, next) ? undefined : next
}
