/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'

export const ACCESS_KEY_PERMISSIONS = [
	'users.read',
	'users.write',
	'user_keys.read',
	'user_keys.write',
	'providers.read',
	'providers.write',
	'providers.secrets.read',
	'models.read',
	'models.write',
	'presets.read',
	'presets.write',
	'guardrails.read',
	'guardrails.write',
	'routes.read',
	'routes.write',
	'config.read',
	'config.write',
	'config.secrets.read',
	'analytics.read',
	'logs.read',
	'playground.execute',
	'*',
] as const

export const accessKeyPermissionSchema = z.enum(ACCESS_KEY_PERMISSIONS)
export type AccessKeyPermission = z.infer<typeof accessKeyPermissionSchema>
export const ACCESS_KEY_DEFAULT_PERMISSIONS: AccessKeyPermission[] = [
	'routes.read',
	'routes.write',
	'analytics.read',
]
export function hasAccessKeyControlCharacters(value: string): boolean {
	return Array.from(value).some((character) => {
		const code = character.charCodeAt(0)
		return code < 32 || code === 127
	})
}
const permissionsSchema = z
	.array(accessKeyPermissionSchema)
	.min(1)
	.max(ACCESS_KEY_PERMISSIONS.length)
	.refine(
		(permissions) =>
			new Set(permissions).size === permissions.length &&
			(!permissions.includes('*') || permissions.length === 1)
	)
const nameSchema = z
	.string()
	.min(1)
	.max(255)
	.refine(
		(value) => value.trim() === value && !hasAccessKeyControlCharacters(value)
	)

export const accessKeyIdSchema = z
	.string()
	.min(1)
	.max(255)
	.refine(
		(value) => value.trim() === value && !hasAccessKeyControlCharacters(value)
	)
const id = accessKeyIdSchema
const instant = z
	.string()
	.max(40)
	.transform((value, context) => {
		const normalized =
			/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/u.test(value)
				? value.replace(' ', 'T') + 'Z'
				: value
		if (
			!z.iso.datetime().safeParse(normalized).success ||
			!Number.isFinite(Date.parse(normalized))
		) {
			context.addIssue({ code: 'custom', message: 'Invalid UTC timestamp' })
			return z.NEVER
		}
		return new Date(normalized).toISOString()
	})
export const accessKeySecretSchema = z
	.string()
	.regex(/^sk-admin-[0-9a-f]{64}$/iu)
const accessKeyPublicSchemaBase = z.object({
	id,
	name: nameSchema,
	description: z.string().max(10_000).nullable(),
	key: z.string().max(64),
	key_prefix: z
		.string()
		.max(12)
		.refine((value) => !hasAccessKeyControlCharacters(value)),
	permissions: permissionsSchema,
	status: z.enum(['active', 'revoked']),
	last_used_at: instant.nullable(),
	created_at: instant,
	updated_at: instant,
	revoked_at: instant.nullable(),
})
export const accessKeyPublicSchema = accessKeyPublicSchemaBase.refine(
	(row) =>
		row.key === row.key_prefix + '••••••••' &&
		(row.id === 'legacy-master' ||
			/^sk-admin-[0-9a-f]{3}$/iu.test(row.key_prefix)),
	{ message: 'Access key list returned an unmasked secret' }
)
export type AccessKey = z.infer<typeof accessKeyPublicSchema>

export const accessKeysResponseSchema = z.object({
	success: z.literal(true),
	data: z
		.array(accessKeyPublicSchema)
		.max(10_000)
		.refine((rows) => new Set(rows.map((row) => row.id)).size === rows.length, {
			message: 'Duplicate integration key IDs',
		}),
})
export const accessKeyResponseSchema = z.object({
	success: z.literal(true),
	data: accessKeyPublicSchema,
})
export const accessKeySecretResponseSchema = z.object({
	success: z.literal(true),
	data: z
		.object({ id, key: z.string().min(1).max(4096) })
		.refine(
			(row) =>
				row.id === 'legacy-master'
					? !hasAccessKeyControlCharacters(row.key)
					: accessKeySecretSchema.safeParse(row.key).success,
			{ message: 'Invalid integration key secret' }
		),
})
export const accessKeyWriteSecretResponseSchema = z.object({
	success: z.literal(true),
	data: accessKeyPublicSchemaBase
		.extend({ key: accessKeySecretSchema })
		.refine((row) => row.key.slice(0, 12) === row.key_prefix, {
			message: 'Integration key prefix does not match the secret',
		}),
})

export const accessKeyDraftSchema = z
	.object({
		name: nameSchema,
		description: z.string().max(10_000).nullable(),
		permissions: permissionsSchema,
		secret_key: accessKeySecretSchema.optional(),
	})
	.strict()
export const accessKeyPatchSchema = accessKeyDraftSchema
	.partial()
	.extend({
		status: z.enum(['active', 'revoked']).optional(),
	})
	.refine((patch) => Object.values(patch).some((value) => value !== undefined))
export type AccessKeyDraft = z.infer<typeof accessKeyDraftSchema>
export type AccessKeyPatch = z.infer<typeof accessKeyPatchSchema>
