import { z } from 'zod'

const identifier = z.string().min(1)
const nullableText = z.string().nullable()
const futureExpirySchema = z.string().refine((value) => {
	const milliseconds = Date.parse(value)
	return (
		Number.isFinite(milliseconds) &&
		new Date(milliseconds).toISOString() === value &&
		milliseconds > Date.now()
	)
}, 'Expiry must be a future canonical UTC timestamp')

export const organizationMembershipSchema = z.object({
	organizationId: identifier,
	organizationName: z.string(),
	organizationSlug: nullableText,
	organizationStatus: z.enum(['active', 'suspended', 'deleted', 'pending']),
	subject: identifier,
	userId: nullableText,
	email: nullableText,
	roles: z.array(z.string()),
	status: z.enum(['active', 'suspended', 'removed']),
	sourceUpdatedAt: z.string(),
})

export const portalMeSchema = z.object({
	userId: identifier,
	subject: identifier,
	email: z.string(),
	isAdmin: z.boolean(),
	// Unknown capabilities remain data; callers must check exact known names.
	capabilities: z.array(z.string()),
	organizations: z.array(organizationMembershipSchema),
})

export const workspaceSchema = z.object({
	id: identifier.max(600),
	name: z.string(),
	slug: z.string(),
	description: nullableText,
	scopeType: z.enum(['personal', 'organization']),
	organizationId: nullableText,
	organizationName: nullableText,
	organizationSlug: nullableText,
	organizationRoles: z.array(z.string()).optional(),
	personalOwnerUserId: nullableText,
	isDefault: z.boolean(),
	status: z.enum(['active', 'archived']),
	role: z.enum(['owner', 'admin', 'member']),
	accessSource: z.enum([
		'personal_owner',
		'organization_default',
		'workspace_membership',
	]),
	createdAt: z.string(),
	updatedAt: z.string(),
})

export const workspaceContextSchema = z
	.object({
		workspaces: z.array(workspaceSchema).min(1),
		currentWorkspace: workspaceSchema,
		preferredWorkspaceAvailable: z.boolean(),
	})
	.refine(
		(context) =>
			context.workspaces.some(
				(workspace) => workspace.id === context.currentWorkspace.id
			),
		{
			message: 'Current workspace is absent from the authorized workspace list',
		}
	)

export const authCheckSchema = z.object({
	authenticated: z.boolean(),
	verification: z.enum(['none', 'verified', 'degraded', 'rejected']),
	principalType: z.string().optional(),
	// Only a live-verified console response provides the associated CinaAuth subject.
	subject: identifier.max(600).optional(),
})

export const gatewayKeySchema = z.object({
	id: identifier,
	workspaceId: identifier,
	// This endpoint only returns masked keys. Reject a full credential here.
	key: z.string().regex(/^sk-[^\r\n]*…[^\r\n]*$/u),
	name: nullableText,
	// Admin status updates preserve arbitrary strings; only exact 'active' grants use.
	status: z.string(),
	limit: z.number().finite().nonnegative().nullable(),
	limitReset: z.enum(['daily', 'weekly', 'monthly']).nullable(),
	expiresAt: nullableText,
	lastUsedAt: nullableText,
	createdAt: z.string(),
})

export const createdGatewayKeySchema = z.object({
	key: z.string().regex(/^sk-[A-Za-z0-9]{32}$/u),
	key_id: identifier,
	workspace_id: identifier,
})

export const createGatewayKeyInputSchema = z.object({
	name: z.string().trim().min(1).max(128).optional(),
	limit: z
		.number()
		.finite()
		.nonnegative()
		.refine(
			(amount) => Number.isSafeInteger(Math.round(amount * 1_000_000)),
			'Limit exceeds the supported micro-unit range'
		)
		.nullable()
		.optional(),
	limit_reset: z.enum(['daily', 'weekly', 'monthly']).nullable().optional(),
	expires_at: futureExpirySchema.nullable().optional(),
})

export const managementKeyAccountSchema = z.discriminatedUnion('account_type', [
	z.object({
		account_type: z.literal('personal'),
		personal_owner_user_id: identifier,
		organization_id: z.null(),
	}),
	z.object({
		account_type: z.literal('organization'),
		personal_owner_user_id: z.null(),
		organization_id: identifier,
	}),
])

const managementKeyFields = {
	id: identifier,
	label: z.string().regex(/^sk-[^\r\n]*…[^\r\n]*$/u),
	name: z.string(),
	status: z.enum(['active', 'revoked']),
	expires_at: nullableText,
	last_used_at: nullableText,
	created_at: z.string(),
	updated_at: z.string(),
}

export const managementKeySchema = z.discriminatedUnion('account_type', [
	managementKeyAccountSchema.options[0].extend(managementKeyFields),
	managementKeyAccountSchema.options[1].extend(managementKeyFields),
])

export const createManagementKeyInputSchema = z.object({
	name: z.string().trim().min(1).max(128),
	expires_at: futureExpirySchema.nullable().optional(),
})

export const createdManagementKeySchema = z.object({
	success: z.literal(true),
	data: managementKeySchema,
	key: z.string().regex(/^sk-cina-mgmt-[0-9a-f]{64}$/u),
})

export type PortalMe = z.infer<typeof portalMeSchema>
export type Workspace = z.infer<typeof workspaceSchema>
export type WorkspaceContext = z.infer<typeof workspaceContextSchema>
export type AuthCheck = z.infer<typeof authCheckSchema>
export type GatewayKey = z.infer<typeof gatewayKeySchema>
export type GatewayKeyContext = {
	keys: GatewayKey[]
	billingCurrency: string
	workspaceId: string
}
export type CreatedGatewayKey = z.infer<typeof createdGatewayKeySchema>
export type CreateGatewayKeyInput = z.infer<typeof createGatewayKeyInputSchema>
export type ManagementKeyAccount = z.infer<typeof managementKeyAccountSchema>
export type ManagementKey = z.infer<typeof managementKeySchema>
export type CreateManagementKeyInput = z.infer<
	typeof createManagementKeyInputSchema
>
export type CreatedManagementKey = Pick<
	z.infer<typeof createdManagementKeySchema>,
	'data' | 'key'
>
