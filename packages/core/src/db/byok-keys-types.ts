import type {
	ManagementApiKeyAccount,
	ManagementApiKeyPrincipal,
} from './management-api-keys-types';

export const BYOK_MAX_CREDENTIAL_BYTES = 64 * 1024;
export const BYOK_MAX_KEYS_PER_WORKSPACE_PROVIDER = 100;
export const BYOK_MAX_ALLOWLIST_ITEMS = 100;
export const BYOK_MAX_RUNTIME_KEYS = 32;

export type ByokKeyRow = {
	id: string;
	workspace_id: string;
	provider: string;
	name: string | null;
	label: string;
	disabled: boolean;
	is_fallback: boolean;
	always_use_for_provider: boolean;
	always_use_for_matching_models: boolean;
	sort_order: number;
	allowed_models: string[] | null;
	allowed_user_ids: string[] | null;
	allowed_api_key_hashes: string[] | null;
	created_by_management_key_id: string | null;
	created_at: string;
	updated_at: string;
};

export type ByokRuntimeKeyRow = ByokKeyRow & {
	/** Plaintext exists only on the runtime path beyond the encrypted repository boundary. */
	api_key: string;
};

export type ByokKeyListPage = {
	data: ByokKeyRow[];
	totalCount: number;
};

export type ByokKeyCreate = {
	workspaceId: string;
	provider: string;
	name: string | null;
	apiKey: string;
	label: string;
	disabled: boolean;
	isFallback: boolean;
	alwaysUseForProvider: boolean;
	alwaysUseForMatchingModels: boolean;
	allowedModels: string[] | null;
	allowedUserIds: string[] | null;
	allowedApiKeyHashes: string[] | null;
};

export type ByokKeyPatch = {
	name?: string | null;
	apiKey?: string;
	label?: string;
	disabled?: boolean;
	isFallback?: boolean;
	alwaysUseForProvider?: boolean;
	alwaysUseForMatchingModels?: boolean;
	allowedModels?: string[] | null;
	allowedUserIds?: string[] | null;
	allowedApiKeyHashes?: string[] | null;
};

/**
 * Trusted browser-session actor used by the account portal. The route that
 * creates this principal must re-authorize the selected Workspace on every
 * request; storage still pins every mutation to that exact Workspace and an
 * active local user row so a stale or forged browser preference cannot widen
 * access.
 */
export type ByokPortalUserPrincipal = ManagementApiKeyAccount & {
	principalType: 'portal_user';
	userId: string;
	workspaceId: string;
};

export type ByokMutationPrincipal =
	| ManagementApiKeyPrincipal
	| ByokPortalUserPrincipal;

export type ByokManagementMutation = {
	principal: ByokMutationPrincipal;
	id: string;
	nowIso: string;
};

export type ByokKeyInsertParams = {
	principal: ByokMutationPrincipal;
	id: string;
	input: ByokKeyCreate;
	nowIso: string;
};

export type ByokKeyUpdateParams = ByokManagementMutation & {
	patch: ByokKeyPatch;
};

export type ByokKeyReorderItem = {
	id: string;
	isFallback: boolean;
};

export type ByokKeyReorder = {
	workspaceId: string;
	provider: string;
	keys: ByokKeyReorderItem[];
};

export type ByokKeyReorderParams = {
	principal: ByokMutationPrincipal;
	input: ByokKeyReorder;
	nowIso: string;
};

export type ByokKeyReorderResult = 'updated' | 'not_found' | 'conflict';

export type ByokRuntimeLookup = {
	workspaceId: string;
	provider: string;
	modelId: string;
	userId: string;
	apiKeyHash: string;
};

const CREATE_FIELDS = new Set([
	'allowed_api_key_hashes',
	'allowed_models',
	'allowed_user_ids',
	'disabled',
	'is_fallback',
	'always_use_for_provider',
	'always_use_for_matching_models',
	'key',
	'name',
	'provider',
	'workspace_id',
]);
const PATCH_FIELDS = new Set([
	'allowed_api_key_hashes',
	'allowed_models',
	'allowed_user_ids',
	'disabled',
	'is_fallback',
	'always_use_for_provider',
	'always_use_for_matching_models',
	'key',
	'name',
]);
const REORDER_FIELDS = new Set(['keys', 'provider', 'workspace_id']);
const REORDER_ITEM_FIELDS = new Set(['id', 'is_fallback']);
const PROVIDER_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const BYOK_KEY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const API_KEY_HASH = /^[a-f0-9]{64}$/u;
const FORBIDDEN_TEXT = /[\u0000-\u001f\u007f]/u;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertOnlyFields(
	value: Record<string, unknown>,
	allowed: ReadonlySet<string>,
): void {
	const unsupported = Object.keys(value).filter((field) => !allowed.has(field));
	if (unsupported.length > 0) {
		throw new TypeError(`Unsupported BYOK field: ${unsupported.join(', ')}`);
	}
}

function codePointLength(value: string): number {
	return [...value].length;
}

function normalizeOptionalName(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== 'string') throw new TypeError('name must be a string or null');
	const normalized = value.trim();
	if (!normalized) return null;
	if (codePointLength(normalized) > 255 || FORBIDDEN_TEXT.test(normalized)) {
		throw new TypeError('name must contain at most 255 printable characters');
	}
	return normalized;
}

export function normalizeByokProvider(value: unknown): string {
	if (typeof value !== 'string') throw new TypeError('provider is required');
	const normalized = value.trim();
	if (
		!normalized ||
		normalized.length > 128 ||
		!PROVIDER_SLUG.test(normalized)
	) {
		throw new TypeError(
			'provider must be a lowercase alphanumeric slug with optional single hyphens',
		);
	}
	return normalized;
}

export function normalizeByokWorkspaceId(value: unknown): string {
	if (typeof value !== 'string') throw new TypeError('workspace_id is required');
	const normalized = value.trim();
	if (
		!normalized ||
		normalized.length > 600 ||
		FORBIDDEN_TEXT.test(normalized)
	) {
		throw new TypeError('workspace_id is invalid');
	}
	return normalized;
}

function normalizeCredential(value: unknown): string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new TypeError('key is required');
	}
	if (new TextEncoder().encode(value).byteLength > BYOK_MAX_CREDENTIAL_BYTES) {
		throw new TypeError(`key must be at most ${BYOK_MAX_CREDENTIAL_BYTES} bytes`);
	}
	return value;
}

function normalizeBoolean(value: unknown, field: string): boolean {
	if (typeof value !== 'boolean') throw new TypeError(`${field} must be a boolean`);
	return value;
}

function normalizeAllowlist(
	value: unknown,
	options: {
		field: string;
		maxItemLength: number;
		pattern?: RegExp;
		minItems?: number;
	},
): string[] | null {
	if (value === null || value === undefined) return null;
	if (!Array.isArray(value)) {
		throw new TypeError(`${options.field} must be an array or null`);
	}
	if (
		value.length > BYOK_MAX_ALLOWLIST_ITEMS ||
		value.length < (options.minItems ?? 0)
	) {
		throw new TypeError(
			`${options.field} must contain between ${options.minItems ?? 0} and ${BYOK_MAX_ALLOWLIST_ITEMS} items`,
		);
	}
	const normalized: string[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (typeof item !== 'string') {
			throw new TypeError(`${options.field} items must be strings`);
		}
		const text = item.trim();
		if (
			!text ||
			codePointLength(text) > options.maxItemLength ||
			FORBIDDEN_TEXT.test(text) ||
			(options.pattern && !options.pattern.test(text))
		) {
			throw new TypeError(`${options.field} contains an invalid item`);
		}
		if (!seen.has(text)) {
			seen.add(text);
			normalized.push(text);
		}
	}
	if (normalized.length < (options.minItems ?? 0)) {
		throw new TypeError(`${options.field} must contain at least one unique item`);
	}
	return normalized;
}

function models(value: unknown): string[] | null {
	return normalizeAllowlist(value, {
		field: 'allowed_models',
		maxItemLength: 240,
	});
}

function users(value: unknown): string[] | null {
	return normalizeAllowlist(value, {
		field: 'allowed_user_ids',
		maxItemLength: 512,
	});
}

function hashes(value: unknown): string[] | null {
	return normalizeAllowlist(value, {
		field: 'allowed_api_key_hashes',
		maxItemLength: 64,
		pattern: API_KEY_HASH,
		minItems: 1,
	});
}

/** Generate a safe display label without persisting any reusable secret prefix. */
export function byokCredentialLabel(value: string): string {
	const normalized = value.trim();
	if (normalized.length <= 4) return '***';
	return `...${normalized.slice(-4)}`;
}

export function normalizeByokKeyCreate(
	value: unknown,
	defaultWorkspaceId: string,
): ByokKeyCreate {
	if (!isRecord(value)) throw new TypeError('JSON body must be an object');
	assertOnlyFields(value, CREATE_FIELDS);
	const apiKey = normalizeCredential(value.key);
	const isFallback = value.is_fallback === undefined
		? false
		: normalizeBoolean(value.is_fallback, 'is_fallback');
	const alwaysUseForProvider = value.always_use_for_provider === undefined
		? false
		: normalizeBoolean(value.always_use_for_provider, 'always_use_for_provider');
	const alwaysUseForMatchingModels = value.always_use_for_matching_models === undefined
		? false
		: normalizeBoolean(
			value.always_use_for_matching_models,
			'always_use_for_matching_models',
		);
	if (isFallback && (alwaysUseForProvider || alwaysUseForMatchingModels)) {
		throw new TypeError('shared-capacity policies are only valid for prioritized BYOK keys');
	}
	if (alwaysUseForProvider && alwaysUseForMatchingModels) {
		throw new TypeError('shared-capacity policies are mutually exclusive');
	}
	return {
		workspaceId:
			value.workspace_id === undefined
				? normalizeByokWorkspaceId(defaultWorkspaceId)
				: normalizeByokWorkspaceId(value.workspace_id),
		provider: normalizeByokProvider(value.provider),
		name: normalizeOptionalName(value.name),
		apiKey,
		label: byokCredentialLabel(apiKey),
		disabled:
			value.disabled === undefined
				? false
				: normalizeBoolean(value.disabled, 'disabled'),
		isFallback,
		alwaysUseForProvider,
		alwaysUseForMatchingModels,
		allowedModels: models(value.allowed_models),
		allowedUserIds: users(value.allowed_user_ids),
		allowedApiKeyHashes: hashes(value.allowed_api_key_hashes),
	};
}

export function normalizeByokKeyPatch(value: unknown): ByokKeyPatch {
	if (!isRecord(value)) throw new TypeError('JSON body must be an object');
	assertOnlyFields(value, PATCH_FIELDS);
	if (Object.keys(value).length === 0) {
		throw new TypeError('At least one BYOK field is required');
	}
	const patch: ByokKeyPatch = {};
	if ('name' in value) patch.name = normalizeOptionalName(value.name);
	if ('disabled' in value) patch.disabled = normalizeBoolean(value.disabled, 'disabled');
	if ('is_fallback' in value) {
		patch.isFallback = normalizeBoolean(value.is_fallback, 'is_fallback');
	}
	if ('always_use_for_provider' in value) {
		patch.alwaysUseForProvider = normalizeBoolean(
			value.always_use_for_provider,
			'always_use_for_provider',
		);
	}
	if ('always_use_for_matching_models' in value) {
		patch.alwaysUseForMatchingModels = normalizeBoolean(
			value.always_use_for_matching_models,
			'always_use_for_matching_models',
		);
	}
	if (
		patch.isFallback === true
		&& (patch.alwaysUseForProvider === true || patch.alwaysUseForMatchingModels === true)
	) {
		throw new TypeError('shared-capacity policies are only valid for prioritized BYOK keys');
	}
	if (patch.alwaysUseForProvider === true && patch.alwaysUseForMatchingModels === true) {
		throw new TypeError('shared-capacity policies are mutually exclusive');
	}
	if ('allowed_models' in value) patch.allowedModels = models(value.allowed_models);
	if ('allowed_user_ids' in value) patch.allowedUserIds = users(value.allowed_user_ids);
	if ('allowed_api_key_hashes' in value) {
		patch.allowedApiKeyHashes = hashes(value.allowed_api_key_hashes);
	}
	if ('key' in value) {
		patch.apiKey = normalizeCredential(value.key);
		patch.label = byokCredentialLabel(patch.apiKey);
	}
	return patch;
}

/**
 * Normalize a complete provider ordering. Prioritized entries must precede
 * fallback entries because runtime routing always evaluates those partitions
 * on opposite sides of shared/platform capacity.
 */
export function normalizeByokKeyReorder(
	value: unknown,
	defaultWorkspaceId: string,
): ByokKeyReorder {
	if (!isRecord(value)) throw new TypeError('JSON body must be an object');
	assertOnlyFields(value, REORDER_FIELDS);
	if (!Array.isArray(value.keys)) throw new TypeError('keys must be an array');
	if (value.keys.length < 1 || value.keys.length > BYOK_MAX_KEYS_PER_WORKSPACE_PROVIDER) {
		throw new TypeError(
			`keys must contain between 1 and ${BYOK_MAX_KEYS_PER_WORKSPACE_PROVIDER} items`,
		);
	}
	const seen = new Set<string>();
	let reachedFallback = false;
	const keys = value.keys.map((item, index): ByokKeyReorderItem => {
		if (!isRecord(item)) throw new TypeError(`keys[${index}] must be an object`);
		assertOnlyFields(item, REORDER_ITEM_FIELDS);
		if (typeof item.id !== 'string' || !BYOK_KEY_ID.test(item.id.toLowerCase())) {
			throw new TypeError(`keys[${index}].id is invalid`);
		}
		const id = item.id.toLowerCase();
		if (seen.has(id)) throw new TypeError('keys must not contain duplicate ids');
		seen.add(id);
		const isFallback = normalizeBoolean(item.is_fallback, `keys[${index}].is_fallback`);
		if (reachedFallback && !isFallback) {
			throw new TypeError('Prioritized BYOK keys must precede fallback keys');
		}
		reachedFallback ||= isFallback;
		return { id, isFallback };
	});
	return {
		workspaceId:
			value.workspace_id === undefined
				? normalizeByokWorkspaceId(defaultWorkspaceId)
				: normalizeByokWorkspaceId(value.workspace_id),
		provider: normalizeByokProvider(value.provider),
		keys,
	};
}

export function publicByokKey(row: ByokKeyRow) {
	return {
		allowed_api_key_hashes: row.allowed_api_key_hashes,
		allowed_models: row.allowed_models,
		allowed_user_ids: row.allowed_user_ids,
		created_at: row.created_at,
		disabled: row.disabled,
		id: row.id,
		is_fallback: row.is_fallback,
		always_use_for_provider: row.always_use_for_provider,
		always_use_for_matching_models: row.always_use_for_matching_models,
		label: row.label,
		name: row.name,
		provider: row.provider,
		sort_order: row.sort_order,
		workspace_id: row.workspace_id,
	};
}

export function byokAccountFromPrincipal(
	principal: ByokMutationPrincipal,
): ManagementApiKeyAccount {
	return {
		accountType: principal.accountType,
		personalOwnerUserId: principal.personalOwnerUserId,
		organizationId: principal.organizationId,
	};
}

export function isByokPortalUserPrincipal(
	principal: ByokMutationPrincipal,
): principal is ByokPortalUserPrincipal {
	return 'principalType' in principal && principal.principalType === 'portal_user';
}
