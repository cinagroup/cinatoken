import { z } from 'zod'
import type {
	ByokKey,
	CreateByokKeyInput,
	PatchByokKeyInput,
} from '../../byok-contracts'

const prefix = 'cinatoken.account.byok.'
const hash = /^[a-f0-9]{64}$/u
export type RestrictionMode = 'any' | 'list' | 'none'
export type SharedCapacityPolicy = 'allow' | 'matching_models' | 'provider'

function printable(value: string): boolean {
	return Array.from(value).every((character) => {
		const code = character.charCodeAt(0)
		return code >= 32 && code !== 127
	})
}

export function splitByokList(value: string): string[] {
	return [
		...new Set(
			value
				.split(/[\n,]/u)
				.map((item) => item.trim())
				.filter(Boolean)
		),
	]
}

function validList(value: string, length: number, hashes = false): boolean {
	const raw = value
		.split(/[\n,]/u)
		.map((item) => item.trim())
		.filter(Boolean)
	return (
		raw.length <= 100 &&
		raw.every(
			(item) =>
				[...item].length <= length &&
				printable(item) &&
				(!hashes || hash.test(item))
		)
	)
}

export const byokFormSchema = z
	.object({
		provider: z
			.string()
			.trim()
			.min(1, prefix + 'providerInvalid')
			.max(128, prefix + 'providerInvalid')
			.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, prefix + 'providerInvalid'),
		name: z
			.string()
			.refine(
				(value) => [...value.trim()].length <= 255 && printable(value.trim()),
				prefix + 'nameInvalid'
			),
		key: z
			.string()
			.refine(
				(value) => new TextEncoder().encode(value).byteLength <= 65_536,
				prefix + 'secretInvalid'
			),
		isFallback: z.boolean(),
		disabled: z.boolean(),
		sharedCapacityPolicy: z.enum(['allow', 'matching_models', 'provider']),
		modelsMode: z.enum(['any', 'list', 'none']),
		usersMode: z.enum(['any', 'list', 'none']),
		keysMode: z.enum(['any', 'list']),
		allowedModels: z.string(),
		allowedUserIds: z.string(),
		allowedApiKeyHashes: z.string(),
	})
	.superRefine((values, context) => {
		if (values.isFallback && values.sharedCapacityPolicy !== 'allow')
			context.addIssue({
				code: 'custom',
				path: ['sharedCapacityPolicy'],
				message: prefix + 'fallbackPolicyInvalid',
			})
		for (const item of [
			{
				mode: values.modelsMode,
				value: values.allowedModels,
				field: 'allowedModels',
				length: 240,
			},
			{
				mode: values.usersMode,
				value: values.allowedUserIds,
				field: 'allowedUserIds',
				length: 512,
			},
			{
				mode: values.keysMode,
				value: values.allowedApiKeyHashes,
				field: 'allowedApiKeyHashes',
				length: 64,
			},
		]) {
			if (
				item.mode === 'list' &&
				(splitByokList(item.value).length === 0 ||
					!validList(
						item.value,
						item.length,
						item.field === 'allowedApiKeyHashes'
					))
			)
				context.addIssue({
					code: 'custom',
					path: [item.field],
					message:
						prefix +
						(item.field === 'allowedApiKeyHashes'
							? 'hashesInvalid'
							: 'listInvalid'),
				})
		}
	})

export type ByokForm = z.infer<typeof byokFormSchema>
export const EMPTY_BYOK_FORM: ByokForm = {
	provider: '',
	name: '',
	key: '',
	isFallback: false,
	disabled: false,
	sharedCapacityPolicy: 'allow',
	modelsMode: 'any',
	usersMode: 'any',
	keysMode: 'any',
	allowedModels: '',
	allowedUserIds: '',
	allowedApiKeyHashes: '',
}

function restrictionMode(values: string[] | null): RestrictionMode {
	if (values === null) return 'any'
	return values.length === 0 ? 'none' : 'list'
}

export function byokKeyForm(key: ByokKey): ByokForm {
	let policy: SharedCapacityPolicy = 'allow'
	if (key.always_use_for_provider) policy = 'provider'
	else if (key.always_use_for_matching_models) policy = 'matching_models'
	return {
		provider: key.provider,
		name: key.name ?? '',
		key: '',
		isFallback: key.is_fallback,
		disabled: key.disabled,
		sharedCapacityPolicy: policy,
		modelsMode: restrictionMode(key.allowed_models),
		usersMode: restrictionMode(key.allowed_user_ids),
		keysMode: key.allowed_api_key_hashes === null ? 'any' : 'list',
		allowedModels: key.allowed_models?.join('\n') ?? '',
		allowedUserIds: key.allowed_user_ids?.join('\n') ?? '',
		allowedApiKeyHashes: key.allowed_api_key_hashes?.join('\n') ?? '',
	}
}

function allowlist(mode: RestrictionMode, value: string): string[] | null {
	if (mode === 'any') return null
	return mode === 'none' ? [] : splitByokList(value)
}

export function byokPatchInput(values: ByokForm): PatchByokKeyInput {
	const parsed = byokFormSchema.parse(values)
	return {
		name: parsed.name.trim() || null,
		disabled: parsed.disabled,
		is_fallback: parsed.isFallback,
		always_use_for_provider: parsed.sharedCapacityPolicy === 'provider',
		always_use_for_matching_models:
			parsed.sharedCapacityPolicy === 'matching_models',
		allowed_models: allowlist(parsed.modelsMode, parsed.allowedModels),
		allowed_user_ids: allowlist(parsed.usersMode, parsed.allowedUserIds),
		allowed_api_key_hashes: allowlist(
			parsed.keysMode,
			parsed.allowedApiKeyHashes
		),
		...(parsed.key.trim().length > 0 ? { key: parsed.key } : {}),
	}
}

export function byokCreateInput(
	values: ByokForm,
	workspaceId: string
): CreateByokKeyInput {
	const parsed = byokFormSchema.parse(values)
	if (parsed.key.trim().length === 0) throw new Error(prefix + 'secretRequired')
	return {
		...byokPatchInput(parsed),
		provider: parsed.provider,
		key: parsed.key,
		workspace_id: workspaceId,
	}
}

export function orderedByokKeys(rows: readonly ByokKey[]): ByokKey[] {
	return [...rows].sort(
		(left, right) =>
			Number(left.is_fallback) - Number(right.is_fallback) ||
			left.sort_order - right.sort_order ||
			left.id.localeCompare(right.id)
	)
}

/** Reordering must never submit a visible page or a mixed workspace as the full provider group. */
export function completeByokGroup(
	rows: readonly ByokKey[],
	total: number,
	workspaceId: string,
	provider: string
): ByokKey[] {
	if (
		rows.length !== total ||
		total < 1 ||
		total > 100 ||
		new Set(rows.map((row) => row.id)).size !== total ||
		rows.some(
			(row) => row.workspace_id !== workspaceId || row.provider !== provider
		)
	)
		throw new Error(prefix + 'incompleteGroup')
	return [...rows]
}

export function moveByokKey(
	rows: readonly ByokKey[],
	id: string,
	direction: -1 | 1
): ByokKey[] {
	const next = [...rows]
	const index = next.findIndex((row) => row.id === id)
	const target = index + direction
	if (
		index < 0 ||
		target < 0 ||
		target >= next.length ||
		next[index].is_fallback !== next[target].is_fallback
	)
		return next
	;[next[index], next[target]] = [next[target], next[index]]
	return next
}
