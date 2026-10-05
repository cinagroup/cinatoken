/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	ACCESS_KEY_PERMISSIONS,
	accessKeySecretSchema,
	hasAccessKeyControlCharacters,
	type AccessKeyDraft,
	type AccessKeyPermission,
} from './access-key-contracts'

export class AccessKeyInputError extends Error {
	constructor() {
		super('Invalid integration key input')
		this.name = 'AccessKeyInputError'
	}
}

export function generateAccessKeySecret(): string {
	const bytes = new Uint8Array(32)
	crypto.getRandomValues(bytes)
	return (
		'sk-admin-' +
		Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
	)
}

export function toggleAccessKeyPermission(
	current: readonly AccessKeyPermission[],
	permission: AccessKeyPermission
): AccessKeyPermission[] {
	if (permission === '*') return current.includes('*') ? [] : ['*']
	const withoutAll = current.filter((item) => item !== '*')
	return withoutAll.includes(permission)
		? withoutAll.filter((item) => item !== permission)
		: [...withoutAll, permission]
}

export function accessKeyDraft(
	name: string,
	description: string,
	permissions: readonly AccessKeyPermission[],
	secret?: string | null
): AccessKeyDraft {
	const trimmedName = name.trim()
	const normalized = permissions.includes('*')
		? (['*'] as AccessKeyPermission[])
		: [...new Set(permissions)]
	if (
		!trimmedName ||
		trimmedName.length > 255 ||
		description.trim().length > 10_000 ||
		hasAccessKeyControlCharacters(trimmedName) ||
		normalized.length === 0 ||
		normalized.some(
			(permission) => !ACCESS_KEY_PERMISSIONS.includes(permission)
		)
	)
		throw new AccessKeyInputError()
	if (secret != null && !accessKeySecretSchema.safeParse(secret).success)
		throw new AccessKeyInputError()
	return {
		name: trimmedName,
		description: description.trim() || null,
		permissions: normalized,
		...(secret == null ? {} : { secret_key: secret }),
	}
}
