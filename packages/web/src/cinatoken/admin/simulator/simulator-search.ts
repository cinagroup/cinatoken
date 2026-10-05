/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import { gatewayKeyIdSchema } from '../gateway-keys/gateway-key-contracts'
import type { SimulatorSearch } from './simulator-selection'

const text = z
	.string()
	.max(600)
	.refine((value) => value.trim() === value && !/[\p{Cc}\p{Cf}]/u.test(value))
export const simulatorKeyResourceIdSchema = gatewayKeyIdSchema.refine(
	(value) => !value.startsWith('hashref:') && !value.startsWith('sha256:')
)
export const simulatorSearchSchema = z.object({
	kind: z.enum(['llm', 'image', 'audio', 'tool']).optional(),
	model_id: text.optional(),
	route_group: text.optional(),
	protocol: z.enum(['openai', 'anthropic', 'gemini', 'dashscope']).optional(),
	tool: z
		.enum(['web-search', 'web-fetch', 'web-deep-search', 'ai-detection'])
		.optional(),
	key_id: simulatorKeyResourceIdSchema.optional(),
})
export function validateSimulatorSearch(value: unknown): SimulatorSearch {
	const parsed = simulatorSearchSchema.safeParse(value)
	return parsed.success ? parsed.data : { invalidTarget: true }
}
