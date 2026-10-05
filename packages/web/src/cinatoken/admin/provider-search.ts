/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'

export const providerSearchSchema = z.object({
	q: z.string().max(200).catch(''),
	filter: z
		.enum([
			'all',
			'active',
			'disabled',
			'pending',
			'no_key',
			'openai',
			'anthropic',
			'gemini',
			'dashscope',
		])
		.catch('all'),
})

export function validateProviderSearch(value: unknown) {
	return providerSearchSchema.parse(value)
}
