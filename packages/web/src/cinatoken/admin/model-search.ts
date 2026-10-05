/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import { modelIdentitySchema } from './model-contracts'

export const modelSearchSchema = z.object({
	q: z.string().max(200).catch(''),
	vendor: z.string().min(1).max(200).catch('all'),
	kind: z.enum(['all', 'llm', 'image', 'audio', 'rerank']).catch('all'),
	availability: z.enum(['all', 'callable', 'unrouted']).catch('all'),
	edit: modelIdentitySchema.optional().catch(undefined),
	invalidEdit: z
		.preprocess(
			(value) => (value === 'true' ? true : value),
			z.literal(true).optional()
		)
		.catch(undefined),
})

export function validateModelSearch(value: unknown) {
	const input =
		typeof value === 'object' && value !== null && !Array.isArray(value)
			? value
			: {}
	const parsed = modelSearchSchema.parse(input)
	if (
		'edit' in input &&
		input.edit !== undefined &&
		!modelIdentitySchema.safeParse(input.edit).success
	)
		return { ...parsed, invalidEdit: true as const }
	return parsed
}
