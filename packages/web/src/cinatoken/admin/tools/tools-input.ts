/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import {
	toolFieldSchema,
	toolPricesSchema,
	type ToolDetail,
} from './tools-contracts'
import { ToolInputError } from './tools-errors'
import { toolToken, validToolVersion } from './tools-token'

export const toolReason = z
	.string()
	.min(1)
	.refine(
		(value) =>
			Boolean(value.trim()) &&
			[...value].length <= 600 &&
			!/[\p{Cc}\p{Cf}]/u.test(value)
	)
	.transform((value) => value.trim())
export const toolOp = (max: number) =>
	z.discriminatedUnion('op', [
		z.object({ op: z.literal('keep') }).strict(),
		z.object({ op: z.literal('clear') }).strict(),
		z
			.object({
				op: z.literal('set'),
				value: z
					.string()
					.min(1)
					.max(max)
					.refine(
						(value) =>
							value.length <= max &&
							Boolean(value.trim()) &&
							!/[\p{Cc}\p{Cf}]/u.test(value) &&
							value.trim() !== '••••••••'
					)
					.transform((value) => value.trim()),
			})
			.strict(),
	])
export type ToolOp = z.infer<ReturnType<typeof toolOp>>
const credential = toolOp(4096)
export const toolSaveSchema = z
	.object({
		operation: z.enum(['save', 'save_activate']),
		expected_version: toolToken,
		reason: toolReason,
		prices: toolPricesSchema.strict(),
		credentials: z
			.object({
				apiKey: credential.optional(),
				secretId: credential.optional(),
				secretKey: credential.optional(),
			})
			.strict(),
		settings: z
			.object({
				billingUnitChars: z
					.number()
					.int()
					.min(1)
					.max(Number.MAX_SAFE_INTEGER)
					.optional(),
				region: toolOp(64).optional(),
				bizType: toolOp(255).optional(),
			})
			.strict()
			.optional(),
		accept_loss_pricing: z.boolean(),
	})
	.strict()
export type ToolSaveInput = z.infer<typeof toolSaveSchema>
export const toolRevealSchema = z
	.object({
		field: toolFieldSchema,
		expected_version: toolToken,
		reason: toolReason,
	})
	.strict()
export type ToolRevealInput = z.infer<typeof toolRevealSchema>
export function validateToolSave(
	detail: ToolDetail,
	input: ToolSaveInput
): ToolSaveInput {
	const checked = toolSaveSchema.safeParse(input)
	if (!checked.success) throw new ToolInputError()
	const value = checked.data,
		ai = detail.family === 'ai-detection'
	const fields = Object.keys(value.credentials)
	if (
		!detail.capabilities.can_write ||
		!detail.familyState.editable ||
		detail.billingCurrency.value === null ||
		!validToolVersion(value.expected_version, detail.family) ||
		value.expected_version !== detail.version ||
		(ai
			? fields.length !== 2 ||
				!value.credentials.secretId ||
				!value.credentials.secretKey
			: fields.length !== 1 ||
				!value.credentials.apiKey ||
				value.settings !== undefined) ||
		(value.prices.charged < value.prices.metered && !value.accept_loss_pricing)
	)
		throw new ToolInputError()
	return value
}
export function validateToolReveal(
	detail: ToolDetail,
	input: ToolRevealInput
): ToolRevealInput {
	const checked = toolRevealSchema.safeParse(input)
	if (
		!checked.success ||
		!detail.capabilities.can_reveal ||
		checked.data.expected_version !== detail.version ||
		!detail.configuration.credentials.some(
			(row) => row.field === checked.data.field && row.configured
		)
	)
		throw new ToolInputError()
	return checked.data
}
