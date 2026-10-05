import { z } from 'zod'

export const GUARDRAIL_GROUPS = [
	'anthropic',
	'openai',
	'google',
	'xai',
	'other',
] as const
export const GUARDRAIL_BUILTINS = [
	'email',
	'phone',
	'ssn',
	'credit-card',
	'ip-address',
	'secrets',
	'regex-prompt-injection',
] as const
export const GUARDRAIL_PRIVACY_REASONS = [
	'provider_missing',
	'shared_channel',
	'policy_missing',
	'policy_expired',
	'policy_unverified',
	'subject_mismatch',
	'subject_unverifiable',
	'zdr_not_supported',
	'no_collection_not_supported',
] as const
export const GUARDRAIL_PLANNER_REASONS = [
	'provider_missing',
	'provider_inactive',
	'provider_credential_missing',
	'provider_shared_channel',
	'provider_protocol_unsupported',
	'endpoint_binding_missing',
	'endpoint_binding_ambiguous',
	'endpoint_invalid',
	'endpoint_identity_mismatch',
	'endpoint_subject_unverifiable',
	'endpoint_subject_mismatch',
	'endpoint_metadata_drift',
	'operation_unsupported',
] as const
export const guardrailIdentifier = z.string().min(1).max(600)
const timestamp = z
	.string()
	.refine((value) => Number.isFinite(Date.parse(value)))
const count = z.number().int().nonnegative().safe()
const positive = z.number().int().positive().safe()
const number = z.number().finite().nonnegative()
const name = z.string().trim().min(1).max(128)
const selectors = z.array(z.string().trim().min(1).max(160)).max(64)
const filter = z
	.object({
		id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
		pattern: z.string().min(1).max(512),
		action: z.enum(['block', 'redact']),
		label: z.string().trim().min(1).max(200).optional(),
	})
	.strict()
const filters = z
	.array(filter)
	.max(32)
	.refine((rows) => new Set(rows.map((row) => row.id)).size === rows.length)
const builtin = z
	.object({
		slug: z.enum(GUARDRAIL_BUILTINS),
		action: z.enum(['block', 'redact', 'flag']),
	})
	.strict()
	.refine(
		(row) => row.action !== 'flag' || row.slug === 'regex-prompt-injection'
	)
const builtins = z
	.array(builtin)
	.max(16)
	.refine((rows) => new Set(rows.map((row) => row.slug)).size === rows.length)
export const guardrailConfigSchema = z
	.object({
		allowed_models: selectors.optional(),
		allowed_providers: selectors.optional(),
		ignored_models: selectors.optional(),
		ignored_providers: selectors.optional(),
		input_filters: filters.optional(),
		output_filters: filters.optional(),
		content_filter_builtins: builtins.optional(),
		budget: z
			.object({
				limit: number
					.positive()
					.max(1_000_000_000)
					.refine((value) => Math.round(value * 1_000_000) > 0),
				period: z.enum(['daily', 'weekly', 'monthly']),
			})
			.strict()
			.optional(),
		data_collection: z.literal('deny').optional(),
		require_zdr: z.boolean().optional(),
		zdr: z
			.object({
				anthropic: z.boolean().optional(),
				openai: z.boolean().optional(),
				google: z.boolean().optional(),
				xai: z.boolean().optional(),
				other: z.boolean().optional(),
			})
			.strict()
			.optional(),
		openrouter: z
			.object({
				enable_free_model_publication: z.literal(true).optional(),
				enable_free_model_training: z.literal(true).optional(),
				enable_paid_model_training: z.literal(true).optional(),
			})
			.strict()
			.optional(),
	})
	.strict()
	.refine(
		(value) =>
			new TextEncoder().encode(JSON.stringify(value)).byteLength <= 64 * 1024
	)

export const guardrailSchema = z
	.object({
		id: guardrailIdentifier,
		workspaceId: guardrailIdentifier,
		ownerUserId: guardrailIdentifier,
		name,
		description: z.string().max(1024).nullable(),
		status: z.enum(['active', 'archived']),
		isWorkspaceDefault: z.boolean(),
		isAccountDefault: z.boolean(),
		accountScopeKey: guardrailIdentifier.nullable(),
		designatedVersion: positive,
		latestVersion: positive,
		config: guardrailConfigSchema.nullable(),
		createdAt: timestamp,
		updatedAt: timestamp,
		versionCreatedAt: timestamp,
		adminManaged: z.boolean(),
		canEdit: z.boolean(),
		canArchive: z.boolean(),
		canRestore: z.boolean(),
		canAssign: z.boolean(),
	})
	.refine((row) => row.designatedVersion <= row.latestVersion)
export const guardrailVersionSchema = z.object({
	id: guardrailIdentifier,
	version: positive,
	config: guardrailConfigSchema.nullable(),
	createdByUserId: guardrailIdentifier.nullable(),
	createdAt: timestamp,
})
export const guardrailAssignmentSchema = z.object({
	id: guardrailIdentifier,
	workspaceId: guardrailIdentifier,
	guardrailId: guardrailIdentifier,
	guardrailName: z.string().nullable(),
	scopeType: z.enum(['user', 'api_key']),
	scopeId: guardrailIdentifier,
	createdByUserId: guardrailIdentifier.nullable(),
	createdAt: timestamp,
	managementSource: z.enum(['admin', 'management_api']).nullable(),
	assignedByUserId: guardrailIdentifier.nullable(),
	canUnbind: z.boolean(),
})
export const guardrailScopeSchema = z.object({
	workspaceId: guardrailIdentifier,
	userId: guardrailIdentifier,
	accountScopeKey: guardrailIdentifier,
	budgetCurrency: z.string().regex(/^[A-Z]{3}$/),
})
const context = guardrailScopeSchema.shape
export const guardrailListResponseSchema = z.object({
	success: z.literal(true),
	data: z.object({ ...context, guardrails: z.array(guardrailSchema) }),
})
export const guardrailRowResponseSchema = z.object({
	success: z.literal(true),
	...context,
	data: guardrailSchema.nullable(),
})
export const guardrailVersionsResponseSchema = z.object({
	success: z.literal(true),
	...context,
	guardrailId: guardrailIdentifier,
	data: z.array(guardrailVersionSchema),
})
export const guardrailAssignmentsResponseSchema = z.object({
	success: z.literal(true),
	...context,
	guardrailId: guardrailIdentifier,
	data: z.array(guardrailAssignmentSchema),
})
export const guardrailAssignmentResponseSchema = z.object({
	success: z.literal(true),
	...context,
	data: guardrailAssignmentSchema,
})
export const guardrailActionResponseSchema = z.object({
	success: z.literal(true),
	...context,
})
export const guardrailCreateInputSchema = z
	.object({
		name,
		description: z.string().trim().max(1024).nullable(),
		config: guardrailConfigSchema,
	})
	.strict()
export const guardrailPatchInputSchema = z
	.object({
		name: name.optional(),
		description: z.string().trim().max(1024).nullable().optional(),
		status: z.enum(['active', 'archived']).optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0)

const scopeType = z.enum(['account', 'workspace', 'user', 'api_key'])
export const guardrailTraceSchema = z.array(
	z.object({
		assignmentId: guardrailIdentifier,
		guardrailId: guardrailIdentifier,
		guardrailName: z.string(),
		version: positive,
		scopeType,
		scopeId: guardrailIdentifier,
	})
)
const range = z
	.object({ minimum: number.nullable(), maximum: number.nullable() })
	.refine(
		(value) =>
			(value.minimum === null && value.maximum === null) ||
			(value.minimum !== null &&
				value.maximum !== null &&
				value.minimum <= value.maximum)
	)
const example = z.object({
	modelId: z.string(),
	provider: z.string(),
	protocol: z.string(),
	operation: z.string(),
	routeGroup: z.string(),
})
const reasons = <T extends string>(values: readonly T[]) =>
	z.record(
		z.string().refine((value) => values.includes(value as T)),
		count
	)
export const guardrailEffectiveSuccessSchema = z.object({
	success: z.literal(true),
	data: z.object({
		...context,
		apiKeyId: guardrailIdentifier.nullable(),
		pricingCurrency: z.literal('USD'),
		trace: guardrailTraceSchema,
		effective: z.object({
			allowedModels: z.array(z.string()).nullable(),
			ignoredModels: z.array(z.string()),
			allowedProviders: z.array(z.string()).nullable(),
			ignoredProviders: z.array(z.string()),
			dataCollection: z.literal('deny').nullable(),
			requireZdr: z.boolean(),
			zdr: z.object({
				anthropic: z.boolean(),
				openai: z.boolean(),
				google: z.boolean(),
				xai: z.boolean(),
				other: z.boolean(),
			}),
			contentFilterBuiltins: builtins,
			inputFilters: z.array(filter.omit({ pattern: true })),
			outputFilters: z.array(filter.omit({ pattern: true })),
			budgets: z.array(
				z.object({
					guardrailId: guardrailIdentifier,
					guardrailName: z.string(),
					version: positive,
					scopeType,
					scopeId: guardrailIdentifier,
					limit: number.positive(),
					period: z.enum(['daily', 'weekly', 'monthly']),
				})
			),
		}),
		routeCandidates: z.object({
			count,
			modelIds: z.array(z.string()),
			providers: z.array(z.string()),
			examples: z.array(example),
			truncated: z.boolean(),
			requiresEndpointEvidence: z.boolean(),
			routeEvidence: z.object({
				required: z.boolean(),
				checkedCount: count,
				eligibleCount: count,
				excludedCount: count,
				excludedByReason: reasons(GUARDRAIL_PRIVACY_REASONS),
				eligibleExamples: z.array(example),
			}),
			plannerEvidence: z.object({
				checkedCount: count,
				staticallyEligibleCount: count,
				excludedCount: count,
				excludedByReason: reasons(GUARDRAIL_PLANNER_REASONS),
				operationCapabilities: z.object({
					verifiedCount: count,
					requestDependentCount: count,
				}),
				outputCapacity: z.object({
					applicableCount: count,
					knownCount: count,
					unknownCount: count,
					minimumTokens: count.nullable(),
					maximumTokens: count.nullable(),
				}),
				pricing: z.object({
					evidenceReadyCount: count,
					comparableCount: count,
					requestDependentCount: count,
					promptPerMillion: range,
					completionPerMillion: range,
					request: range,
					image: range,
					evaluatedAt: timestamp,
					businessTimezone: z.string().min(1),
				}),
				performance: z.object({
					windowSeconds: count,
					checkedRoutes: count,
					truncated: z.boolean(),
					sampledRoutes: count,
					unsampledRoutes: count,
					sampleCount: count,
					p50LatencyMs: number.nullable(),
					p50ThroughputTokensPerSecond: number.nullable(),
				}),
				requestDependent: z.object({
					wildcardOperationCount: count,
					explicitEndpointOptInCount: count,
				}),
				circuit: z.object({
					evaluated: z.literal(false),
					scope: z.literal('dispatch_isolate'),
				}),
				examples: z.array(example).optional(),
			}),
		}),
	}),
})
export const guardrailEffectiveConflictSchema = z.object({
	success: z.literal(false),
	code: z.literal('guardrail_effective_conflict'),
	message: z.string().min(1),
	...context,
	apiKeyId: guardrailIdentifier.nullable(),
	pricingCurrency: z.literal('USD'),
	trace: guardrailTraceSchema,
})
export const guardrailEffectiveResponseSchema = z.discriminatedUnion(
	'success',
	[guardrailEffectiveSuccessSchema, guardrailEffectiveConflictSchema]
)
export type GuardrailConfig = z.infer<typeof guardrailConfigSchema>
export type Guardrail = z.infer<typeof guardrailSchema>
export type GuardrailVersion = z.infer<typeof guardrailVersionSchema>
export type GuardrailAssignment = z.infer<typeof guardrailAssignmentSchema>
export type GuardrailContext = z.infer<
	typeof guardrailListResponseSchema
>['data']
export type GuardrailInput = z.input<typeof guardrailCreateInputSchema>
export type GuardrailPatch = z.input<typeof guardrailPatchInputSchema>
export type GuardrailPreview = z.infer<
	typeof guardrailEffectiveSuccessSchema
>['data']
export type GuardrailEffective = z.infer<
	typeof guardrailEffectiveResponseSchema
>
export type GuardrailTrace = z.infer<typeof guardrailTraceSchema>
