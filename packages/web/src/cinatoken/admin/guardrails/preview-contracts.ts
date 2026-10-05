/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import {
	guardrailEffectiveConflictSchema,
	guardrailEffectiveSuccessSchema,
} from '../../guardrail-contracts'

/** The user and Console endpoints share one projected, secret-free preview DTO. */
export const adminGuardrailPreviewResponseSchema = z.discriminatedUnion(
	'success',
	[guardrailEffectiveSuccessSchema, guardrailEffectiveConflictSchema]
)

export type AdminGuardrailPreview = z.infer<
	typeof guardrailEffectiveSuccessSchema
>['data']
export type AdminGuardrailPreviewTrace = z.infer<
	typeof guardrailEffectiveConflictSchema
>['trace']

/** The server message is intentionally excluded from browser state. */
export type AdminGuardrailPreviewResult =
	| { kind: 'ready'; preview: AdminGuardrailPreview }
	| {
			kind: 'conflict'
			code: 'guardrail_effective_conflict'
			workspaceId: string
			userId: string
			accountScopeKey: string
			apiKeyId: string | null
			budgetCurrency: string
			pricingCurrency: 'USD'
			trace: AdminGuardrailPreviewTrace
	  }
