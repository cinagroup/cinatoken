/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import type { ToolDetail } from './tools-contracts'
import { ToolInputError } from './tools-errors'
import { toolReason, type ToolOp, type ToolSaveInput } from './tools-input'

export const toolPriceText = z
	.string()
	.regex(/^\d+(?:\.\d{1,6})?$/u)
	.refine(
		(value) =>
			Number(value) <= Number.MAX_SAFE_INTEGER / 1_000_000 &&
			Number.isSafeInteger(Math.round(Number(value) * 1_000_000))
	)
const operation = z.enum(['keep', 'set', 'clear'])
export const toolEditorFormSchema = z
	.object({
		metered: toolPriceText,
		standard: toolPriceText,
		charged: toolPriceText,
		reason: toolReason,
		billingUnitChars: z.string(),
		apiKeyOp: operation,
		apiKey: z.string(),
		secretIdOp: operation,
		secretId: z.string(),
		secretKeyOp: operation,
		secretKey: z.string(),
		regionOp: operation,
		region: z.string(),
		bizTypeOp: operation,
		bizType: z.string(),
	})
	.strict()
	.superRefine((value, context) => {
		for (const [name, max] of [
			['apiKey', 4096],
			['secretId', 4096],
			['secretKey', 4096],
			['region', 64],
			['bizType', 255],
		] as const) {
			if (
				value[`${name}Op`] === 'set' &&
				(!value[name].trim() ||
					value[name].length > max ||
					/[\p{Cc}\p{Cf}]/u.test(value[name]) ||
					value[name].trim() === '••••••••')
			)
				context.addIssue({
					code: 'custom',
					path: [name],
					message: 'Invalid field',
				})
		}
		if (
			value.billingUnitChars !== '' &&
			(!/^[1-9]\d*$/u.test(value.billingUnitChars) ||
				!Number.isSafeInteger(Number(value.billingUnitChars)))
		)
			context.addIssue({
				code: 'custom',
				path: ['billingUnitChars'],
				message: 'Invalid unit',
			})
	})
export type ToolEditorForm = z.infer<typeof toolEditorFormSchema>
export function toolEditorDefaults(detail: ToolDetail): ToolEditorForm {
	const prices = detail.configuration.prices
	return {
		metered: String(prices?.metered ?? 0),
		standard: String(prices?.standard ?? 0),
		charged: String(prices?.charged ?? 0),
		reason: '',
		billingUnitChars:
			detail.family === 'ai-detection'
				? String(detail.configuration.billingUnitChars ?? 2000)
				: '',
		apiKeyOp: 'keep',
		apiKey: '',
		secretIdOp: 'keep',
		secretId: '',
		secretKeyOp: 'keep',
		secretKey: '',
		regionOp: 'keep',
		region: '',
		bizTypeOp: 'keep',
		bizType: '',
	}
}
export function toolEditorPayload(
	detail: ToolDetail,
	form: ToolEditorForm,
	operation: 'save' | 'save_activate',
	acceptLoss: boolean
): ToolSaveInput {
	const checked = toolEditorFormSchema.safeParse(form)
	if (!checked.success) throw new ToolInputError()
	const value = checked.data
	const op = (
		name: 'apiKey' | 'secretId' | 'secretKey' | 'region' | 'bizType'
	): ToolOp =>
		value[`${name}Op`] === 'set'
			? { op: 'set', value: value[name] }
			: { op: value[`${name}Op`] as 'keep' | 'clear' }
	const credentials =
		detail.family === 'ai-detection'
			? { secretId: op('secretId'), secretKey: op('secretKey') }
			: { apiKey: op('apiKey') }
	return {
		operation,
		expected_version: detail.version,
		reason: value.reason,
		prices: {
			metered: Number(value.metered),
			standard: Number(value.standard),
			charged: Number(value.charged),
		},
		credentials,
		...(detail.family === 'ai-detection'
			? {
					settings: {
						billingUnitChars: Number(value.billingUnitChars),
						region: op('region'),
						bizType: op('bizType'),
					},
				}
			: {}),
		accept_loss_pricing: acceptLoss,
	}
}
