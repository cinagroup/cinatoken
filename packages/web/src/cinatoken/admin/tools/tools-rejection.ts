/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import { CinaTokenApiError } from '../../api'

export const toolRejectedSchema = z.object({
	success: z.literal(false),
	code: z.enum([
		'tools_activation_required',
		'tools_provider_not_ready',
		'tools_loss_pricing_confirmation_required',
		'tools_version_conflict',
		'invalid_source',
		'console_subject_mismatch',
	]),
})
export class ToolRejectedError extends CinaTokenApiError {
	constructor(readonly rejection: z.infer<typeof toolRejectedSchema>['code']) {
		super('Tools operation was rejected', 409, 'http')
	}
}
export function acceptToolRejection(
	response: Response,
	body: unknown
): boolean {
	const parsed = toolRejectedSchema.safeParse(body)
	if (!parsed.success) return false
	return parsed.data.code === 'console_subject_mismatch'
		? response.status === 403
		: response.status === 409
}
