import {
	validateAccountDefaultGuardrailConfig,
	validateGuardrailConfig,
	type GuardrailConfig,
	type GuardrailFilter,
} from './guardrails';
import type { ManagementApiKeyAccount } from './db/management-api-keys-types';
import {
	GUARDRAIL_DETERMINISTIC_BUILTIN_SLUGS,
	GUARDRAIL_EXTERNAL_DETECTION_BUILTIN_SLUGS,
	type GuardrailBuiltinFilter,
	type GuardrailDeterministicBuiltinSlug,
} from './guardrail-builtins';

export const MANAGEMENT_GUARDRAIL_MAX_BODY_BYTES = 96 * 1024;
export const MANAGEMENT_GUARDRAIL_ASSIGNMENT_MAX_BODY_BYTES = 64 * 1024;

export type ManagementGuardrailKeyAssignment = {
	id: string;
	guardrail_id: string;
	key_hash: string;
	key_label: string | null;
	key_name: string | null;
	assigned_by: string;
	created_at: string;
};

export type ManagementGuardrailMemberAssignment = {
	id: string;
	guardrail_id: string;
	organization_id: string;
	user_id: string;
	assigned_by: string;
	created_at: string;
};

export type ManagementGuardrailAssignmentPage<T> = {
	data: T[];
	totalCount: number;
};

export type ManagementGuardrailAssignmentMutationResult =
	| { status: 'ok'; count: number }
	| { status: 'not_found' }
	| { status: 'creator_unavailable' };

export type ManagementGuardrailRow = {
	id: string;
	workspace_id: string;
	owner_user_id: string;
	name: string;
	description: string | null;
	status: 'active' | 'archived';
	is_workspace_default: boolean;
	is_account_default: boolean;
	account_scope_key: string | null;
	designated_version: number;
	latest_version: number;
	config_json: string;
	created_at: string;
	updated_at: string;
};

export type ManagementGuardrailPage = {
	data: ManagementGuardrailRow[];
	totalCount: number;
};

export type ManagementGuardrailMutationPrincipal = {
	keyId: string;
	createdByUserId: string | null;
	account: ManagementApiKeyAccount;
};

export type ManagementGuardrailCreate = {
	workspaceId: string;
	name: string;
	description: string | null;
	config: GuardrailConfig;
	configJson: string;
};

export type ManagementGuardrailPatch = {
	name: string;
	description: string | null;
	config: GuardrailConfig;
	configJson: string;
	expectedVersion: number;
};

export type ManagementGuardrailMutationResult =
	| { status: 'ok'; row: ManagementGuardrailRow }
	| { status: 'not_found' | 'conflict' | 'creator_unavailable' };

const CREATE_FIELDS = new Set([
	'allowed_models', 'allowed_providers', 'content_filter_builtins', 'content_filters',
	'data_collection',
	'description', 'enable_free_model_publication', 'enable_free_model_training',
	'enable_paid_model_training', 'enforce_zdr', 'enforce_zdr_anthropic',
	'enforce_zdr_google', 'enforce_zdr_openai', 'enforce_zdr_other', 'enforce_zdr_xai',
	'ignored_models', 'ignored_providers', 'include_byok_in_budgets', 'limit_usd',
	'name', 'reset_interval', 'workspace_id',
]);
const PATCH_FIELDS = new Set([...CREATE_FIELDS].filter((field) => field !== 'workspace_id'));
const ZDR_GROUPS = ['anthropic', 'google', 'openai', 'other', 'xai'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function name(value: unknown): string {
	if (typeof value !== 'string') throw new TypeError('name is required');
	const normalized = value.trim();
	if (!normalized || normalized.length > 200) throw new TypeError('name must contain 1-200 characters');
	return normalized;
}

function description(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== 'string') throw new TypeError('description must be a string or null');
	const normalized = value.trim();
	if (normalized.length > 1000) throw new TypeError('description must be at most 1000 characters');
	return normalized || null;
}

function stringList(value: unknown, field: string): string[] | null {
	if (value === null) return null;
	if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
		throw new TypeError(`${field} must be null or an array of 1-64 values`);
	}
	const result: string[] = [];
	for (const item of value) {
		if (typeof item !== 'string' || !item.trim() || item.trim().length > 160) {
			throw new TypeError(`${field} contains an invalid value`);
		}
		const normalized = item.trim();
		if (!result.some((candidate) => candidate.toLowerCase() === normalized.toLowerCase())) result.push(normalized);
	}
	return result;
}

function nullableBoolean(value: unknown, field: string): boolean | null {
	if (value === null) return null;
	if (typeof value !== 'boolean') throw new TypeError(`${field} must be a boolean or null`);
	return value;
}

function permissivePolicy(value: unknown, field: string): true | null {
	const parsed = nullableBoolean(value, field);
	if (parsed === false) {
		throw new TypeError(`${field}=false is unavailable until endpoint training/publication evidence is enforced`);
	}
	return parsed;
}

function contentFilters(value: unknown): GuardrailFilter[] | null {
	if (value === null) return null;
	if (!Array.isArray(value) || value.length > 32) {
		throw new TypeError('content_filters must be null or an array of at most 32 filters');
	}
	return value.map((item, index) => {
		if (!isRecord(item)) throw new TypeError(`content_filters[${index}] must be an object`);
		const unsupported = Object.keys(item).filter((field) => !['action', 'label', 'pattern'].includes(field));
		if (unsupported.length > 0) throw new TypeError(`content_filters[${index}] contains unsupported fields: ${unsupported.join(', ')}`);
		if (item.action !== 'block' && item.action !== 'redact') {
			throw new TypeError(`content_filters[${index}].action must be block or redact`);
		}
		if (typeof item.pattern !== 'string') throw new TypeError(`content_filters[${index}].pattern is required`);
		let label: string | undefined;
		if (item.label !== undefined && item.label !== null) {
			if (typeof item.label !== 'string' || !item.label.trim() || item.label.trim().length > 200) {
				throw new TypeError(`content_filters[${index}].label must contain 1-200 characters`);
			}
			label = item.label.trim();
		}
		return {
			id: `management-${index + 1}`,
			pattern: item.pattern,
			action: item.action,
			...(label ? { label } : {}),
		};
	});
}

function contentFilterBuiltins(value: unknown): GuardrailBuiltinFilter[] | null {
	if (value === null) return null;
	if (!Array.isArray(value) || value.length > 16) {
		throw new TypeError('content_filter_builtins must be null or an array of at most 16 filters');
	}
	return value.map((item, index) => {
		if (!isRecord(item)) throw new TypeError(`content_filter_builtins[${index}] must be an object`);
		const unsupported = Object.keys(item).filter((field) => field !== 'slug' && field !== 'action');
		if (unsupported.length > 0) {
			throw new TypeError(`content_filter_builtins[${index}] contains unsupported fields: ${unsupported.join(', ')}`);
		}
		if (typeof item.slug !== 'string') throw new TypeError(`content_filter_builtins[${index}].slug is required`);
		if ((GUARDRAIL_EXTERNAL_DETECTION_BUILTIN_SLUGS as readonly string[]).includes(item.slug)) {
			throw new TypeError(`content_filter_builtins slug ${item.slug} requires an unavailable external detector`);
		}
		if (!(GUARDRAIL_DETERMINISTIC_BUILTIN_SLUGS as readonly string[]).includes(item.slug)) {
			throw new TypeError(`content_filter_builtins[${index}].slug is unsupported`);
		}
		if (item.action !== 'block' && item.action !== 'redact' && item.action !== 'flag') {
			throw new TypeError(`content_filter_builtins[${index}].action must be block, redact, or flag`);
		}
		if (item.action === 'flag' && item.slug !== 'regex-prompt-injection') {
			throw new TypeError('flag is only available for regex-prompt-injection');
		}
		return {
			slug: item.slug as GuardrailDeterministicBuiltinSlug,
			action: item.action,
		};
	});
}

function resetInterval(value: unknown): 'daily' | 'weekly' | 'monthly' | null {
	if (value === null) return null;
	if (value !== 'daily' && value !== 'weekly' && value !== 'monthly') {
		throw new TypeError('reset_interval must be daily, weekly, monthly, or null');
	}
	return value;
}

function limitUsd(value: unknown): number | null {
	if (value === null) return null;
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1_000_000_000) {
		throw new TypeError('limit_usd must be a finite number greater than zero or null');
	}
	return value;
}

function setOrDelete<T extends object, K extends keyof T>(target: T, field: K, value: T[K] | null): void {
	if (value === null) delete target[field];
	else target[field] = value;
}

function applyConfigFields(
	current: GuardrailConfig,
	body: Record<string, unknown>,
	accountDefault = false,
): GuardrailConfig {
	const config: GuardrailConfig = JSON.parse(JSON.stringify(current)) as GuardrailConfig;
	for (const field of ['allowed_models', 'allowed_providers', 'ignored_models', 'ignored_providers'] as const) {
		if (field in body) setOrDelete(config, field, stringList(body[field], field));
	}
	if ('content_filter_builtins' in body) {
		setOrDelete(config, 'content_filter_builtins', contentFilterBuiltins(body.content_filter_builtins));
	}
	if ('content_filters' in body) setOrDelete(config, 'input_filters', contentFilters(body.content_filters));
	if ('data_collection' in body) {
		if (body.data_collection === null) delete config.data_collection;
		else if (body.data_collection === 'deny') config.data_collection = 'deny';
		else throw new TypeError('data_collection must be deny or null');
	}

	const zdr = { ...(config.zdr ?? {}) };
	const hasLegacy = 'enforce_zdr' in body;
	const legacy = hasLegacy ? nullableBoolean(body.enforce_zdr, 'enforce_zdr') : undefined;
	for (const group of ZDR_GROUPS) {
		const field = `enforce_zdr_${group}`;
		const explicit = field in body;
		const value = explicit ? nullableBoolean(body[field], field) : hasLegacy ? legacy! : undefined;
		if (value === undefined) continue;
		if (value === null) delete zdr[group];
		else zdr[group] = value;
	}
	if (Object.keys(zdr).length > 0) config.zdr = zdr;
	else delete config.zdr;

	const policy = { ...(config.openrouter ?? {}) };
	for (const field of [
		'enable_free_model_publication',
		'enable_free_model_training',
		'enable_paid_model_training',
	] as const) {
		if (!(field in body)) continue;
		const value = permissivePolicy(body[field], field);
		if (value === null) delete policy[field];
		else policy[field] = value;
	}
	if (Object.keys(policy).length > 0) config.openrouter = policy;
	else delete config.openrouter;

	if ('include_byok_in_budgets' in body && body.include_byok_in_budgets !== false) {
		throw new TypeError('include_byok_in_budgets must remain false until BYOK routing is available');
	}
	const hasLimit = 'limit_usd' in body;
	const hasReset = 'reset_interval' in body;
	if (hasLimit || hasReset) {
		const limit = hasLimit ? limitUsd(body.limit_usd) : config.budget?.limit ?? null;
		const period = hasReset ? resetInterval(body.reset_interval) : config.budget?.period ?? null;
		if ((limit === null) !== (period === null)) {
			throw new TypeError('limit_usd and reset_interval must both be configured or both be null');
		}
		if (limit === null || period === null) delete config.budget;
		else config.budget = { limit, period };
	}

	const validated = accountDefault
		? validateAccountDefaultGuardrailConfig(config)
		: validateGuardrailConfig(config);
	if (!validated.ok) throw new TypeError(validated.message);
	return validated.value;
}

function parseStoredConfig(configJson: string, accountDefault = false): GuardrailConfig {
	let parsed: unknown;
	try { parsed = JSON.parse(configJson) as unknown; }
	catch { throw new Error('Stored Guardrail configuration is invalid'); }
	const validated = accountDefault
		? validateAccountDefaultGuardrailConfig(parsed)
		: validateGuardrailConfig(parsed);
	if (!validated.ok) throw new Error('Stored Guardrail configuration is invalid');
	return validated.value;
}

function assertFields(body: Record<string, unknown>, allowed: ReadonlySet<string>): void {
	const unsupported = Object.keys(body).filter((field) => !allowed.has(field));
	if (unsupported.length > 0) throw new TypeError(`Unsupported guardrail field: ${unsupported.join(', ')}`);
}

function assignmentValues(
	value: unknown,
	field: 'key_hashes' | 'member_user_ids',
): string[] {
	if (!isRecord(value)) throw new TypeError('JSON body must be an object');
	assertFields(value, new Set([field]));
	const items = value[field];
	if (!Array.isArray(items) || items.length < 1 || items.length > 100) {
		throw new TypeError(`${field} must be an array of 1-100 values`);
	}
	const result: string[] = [];
	for (const item of items) {
		if (typeof item !== 'string') throw new TypeError(`${field} contains an invalid value`);
		const normalized = item.trim();
		if (field === 'key_hashes') {
			if (!/^[a-f0-9]{64}$/iu.test(normalized)) {
				throw new TypeError('key_hashes must contain 64-character SHA-256 hashes');
			}
			const hash = normalized.toLowerCase();
			if (!result.includes(hash)) result.push(hash);
			continue;
		}
		if (!normalized || normalized.length > 512) {
			throw new TypeError('member_user_ids contains an invalid value');
		}
		if (!result.includes(normalized)) result.push(normalized);
	}
	return result;
}

export function normalizeManagementGuardrailKeyAssignmentBody(value: unknown): string[] {
	return assignmentValues(value, 'key_hashes');
}

export function normalizeManagementGuardrailMemberAssignmentBody(value: unknown): string[] {
	return assignmentValues(value, 'member_user_ids');
}

export function normalizeManagementGuardrailCreate(
	value: unknown,
	workspaceId: string,
): ManagementGuardrailCreate {
	if (!isRecord(value)) throw new TypeError('JSON body must be an object');
	assertFields(value, CREATE_FIELDS);
	const config = applyConfigFields({}, value);
	return {
		workspaceId,
		name: name(value.name),
		description: description(value.description),
		config,
		configJson: JSON.stringify(config),
	};
}

export function normalizeManagementGuardrailPatch(
	value: unknown,
	current: ManagementGuardrailRow,
): ManagementGuardrailPatch {
	if (!isRecord(value)) throw new TypeError('JSON body must be an object');
	assertFields(value, PATCH_FIELDS);
	if (Object.keys(value).length === 0) throw new TypeError('At least one guardrail field is required');
	if ((current.is_workspace_default || current.is_account_default) && 'name' in value && value.name !== current.name) {
		throw new TypeError('Default Guardrail name is immutable');
	}
	const config = applyConfigFields(
		parseStoredConfig(current.config_json, current.is_account_default),
		value,
		current.is_account_default,
	);
	return {
		name: 'name' in value ? name(value.name) : current.name,
		description: 'description' in value ? description(value.description) : current.description,
		config,
		configJson: JSON.stringify(config),
		expectedVersion: current.latest_version,
	};
}

export function publicManagementGuardrail(row: ManagementGuardrailRow) {
	const config = parseStoredConfig(row.config_json, row.is_account_default);
	const groups = ZDR_GROUPS.map((group) => config.zdr?.[group] ?? null);
	const legacyZdr = groups.every((value) => value === true)
		? true
		: groups.every((value) => value === false)
			? false
			: null;
	return {
		allowed_models: config.allowed_models ?? null,
		allowed_providers: config.allowed_providers ?? null,
		content_filter_builtins: config.content_filter_builtins ?? null,
		content_filters: config.input_filters?.map((filter) => ({
			action: filter.action,
			...(filter.label ? { label: filter.label } : {}),
			pattern: filter.pattern,
		})) ?? null,
		data_collection: config.data_collection ?? null,
		created_at: row.created_at,
		description: row.description,
		enable_free_model_publication: config.openrouter?.enable_free_model_publication ?? null,
		enable_free_model_training: config.openrouter?.enable_free_model_training ?? null,
		enable_paid_model_training: config.openrouter?.enable_paid_model_training ?? null,
		enforce_zdr: legacyZdr,
		enforce_zdr_anthropic: config.zdr?.anthropic ?? null,
		enforce_zdr_google: config.zdr?.google ?? null,
		enforce_zdr_openai: config.zdr?.openai ?? null,
		enforce_zdr_other: config.zdr?.other ?? null,
		enforce_zdr_xai: config.zdr?.xai ?? null,
		id: row.id,
		is_account_default: row.is_account_default,
		is_workspace_default: row.is_workspace_default,
		account_scope_key: row.account_scope_key,
		ignored_models: config.ignored_models ?? null,
		ignored_providers: config.ignored_providers ?? null,
		include_byok_in_budgets: false,
		limit_usd: config.budget?.limit ?? null,
		name: row.name,
		reset_interval: config.budget?.period ?? null,
		updated_at: row.updated_at === row.created_at ? null : row.updated_at,
		workspace_id: row.workspace_id,
	};
}
