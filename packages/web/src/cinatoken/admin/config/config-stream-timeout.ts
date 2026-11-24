/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import {
	normalizeFirstEventTimeoutMsInput,
	normalizeFirstEventTimeoutRouteGroupsInput,
} from '@octafuse/core/lib/stream-first-event-timeout-config'

export const streamTimeoutFieldSchema = z.enum([
	'streamFirstEventTimeoutMs',
	'streamFirstEventTimeoutRouteGroups',
])
export type StreamTimeoutField = z.infer<typeof streamTimeoutFieldSchema>
export class StreamTimeoutInputError extends Error {
	constructor() {
		super('Invalid stream timeout configuration')
		this.name = 'StreamTimeoutInputError'
	}
}
export function normalizeStreamTimeout(
	field: StreamTimeoutField,
	raw: unknown
): string {
	if (!streamTimeoutFieldSchema.safeParse(field).success)
		throw new StreamTimeoutInputError()
	const value =
		field === 'streamFirstEventTimeoutMs'
			? normalizeFirstEventTimeoutMsInput(raw)
			: normalizeFirstEventTimeoutRouteGroupsInput(raw)
	if (value === null) throw new StreamTimeoutInputError()
	return value
}
export function streamTimeoutFormSchema(field: StreamTimeoutField) {
	return z.object({
		value: z.string().refine((value) => {
			try {
				normalizeStreamTimeout(field, value)
				return true
			} catch {
				return false
			}
		}),
	})
}
