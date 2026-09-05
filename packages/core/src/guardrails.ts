import type { GatewayRepositories } from './storage/repositories-types';
import type {
	EffectiveGuardrailRow,
	GuardrailEffectiveScopeType,
	GuardrailWithVersionRow,
} from './db/guardrails-types';
import type { ModelRouteJoinRow } from './storage/repository-dtos';
import type { RouteDataPolicyRow } from './db/route-data-policy-types';
import type { ProviderRow } from './types';
import {
	computeRouteDataPolicySubjectFingerprintFromRows,
	effectiveRouteDataPolicyStatus,
	routeDataPolicyAllowsZdr,
	routeDataPolicyDeniesCollection,
	routeDataPolicySubjectMatches,
} from './route-data-policy';
import {
	guardrailBudgetAmount,
	guardrailBudgetUnits,
	type GuardrailBudgetIntent,
	type GuardrailBudgetPeriod,
} from './db/guardrail-budget-types';
import {
	detectGuardrailBuiltin,
	GUARDRAIL_DETERMINISTIC_BUILTIN_SLUGS,
	GUARDRAIL_EXTERNAL_DETECTION_BUILTIN_SLUGS,
	guardrailBuiltinPublicLabel,
	redactGuardrailBuiltin,
	type GuardrailBuiltinAction,
	type GuardrailBuiltinFilter,
	type GuardrailDeterministicBuiltinSlug,
} from './guardrail-builtins';

export const GUARDRAIL_MAX_CONFIG_BYTES = 64 * 1024;
export const GUARDRAIL_MAX_FILTERS_PER_DIRECTION = 32;
export const GUARDRAIL_MAX_PATTERN_LENGTH = 512;
export const GUARDRAIL_MAX_SCANNED_TEXT_BYTES = 256 * 1024;
export const GUARDRAIL_MAX_BOUNDED_REPETITION = 256;
export const GUARDRAIL_MAX_EXACT_REPETITION = 4096;

export type GuardrailFilterAction = 'block' | 'redact';
export type GuardrailFilter = {
	id: string;
	pattern: string;
	action: GuardrailFilterAction;
	/** Optional public replacement/error label used by Management Guardrails. */
	label?: string;
};
export type GuardrailBudget = {
	limit: number;
	period: GuardrailBudgetPeriod;
};
export type GuardrailConfig = {
	allowed_models?: string[];
	allowed_providers?: string[];
	ignored_models?: string[];
	ignored_providers?: string[];
	input_filters?: GuardrailFilter[];
	output_filters?: GuardrailFilter[];
	content_filter_builtins?: GuardrailBuiltinFilter[];
	budget?: GuardrailBudget;
	/** Restrictive account/workspace privacy ceiling; absence keeps caller defaults. */
	data_collection?: 'deny';
	require_zdr?: boolean;
	zdr?: Partial<Record<'anthropic' | 'openai' | 'google' | 'xai' | 'other', boolean>>;
	/** OpenRouter fields that are currently safe only in their permissive state. */
	openrouter?: {
		enable_free_model_publication?: true;
		enable_free_model_training?: true;
		enable_paid_model_training?: true;
	};
};

export type GuardrailRuntimeTrace = {
	assignmentId: string;
	guardrailId: string;
	guardrailName: string;
	version: number;
	scopeType: GuardrailEffectiveScopeType;
	scopeId: string;
};

export type GuardrailEffectivePreview = {
	trace: GuardrailRuntimeTrace[];
	effective: {
		allowedModels: string[] | null;
		ignoredModels: string[];
		allowedProviders: string[] | null;
		ignoredProviders: string[];
		dataCollection: 'deny' | null;
		requireZdr: boolean;
		zdr: Record<'anthropic' | 'openai' | 'google' | 'xai' | 'other', boolean>;
		contentFilterBuiltins: GuardrailBuiltinFilter[];
		inputFilters: Array<Pick<GuardrailFilter, 'id' | 'action' | 'label'>>;
		outputFilters: Array<Pick<GuardrailFilter, 'id' | 'action' | 'label'>>;
		budgets: Array<{
			guardrailId: string;
			guardrailName: string;
			version: number;
			scopeType: GuardrailEffectiveScopeType;
			scopeId: string;
			limit: number;
			period: GuardrailBudgetPeriod;
		}>;
	};
	routeCandidates: {
		/** Active route identities that pass model/provider Guardrail controls. */
		count: number;
		modelIds: string[];
		providers: string[];
		examples: Array<{
			modelId: string;
			provider: string;
			protocol: string;
			operation: string;
			routeGroup: string;
		}>;
		truncated: boolean;
		/** ZDR/no-collection still requires current endpoint-subject evidence at dispatch. */
		requiresEndpointEvidence: boolean;
	};
};

export type GuardrailEffectivePreviewResult =
	| { ok: true; value: GuardrailEffectivePreview; candidateRoutes: ModelRouteJoinRow[] }
	| { ok: false; trace: GuardrailRuntimeTrace[]; message: string };

export type GuardrailRouteEvidenceExclusionReason =
	| 'provider_missing'
	| 'shared_channel'
	| 'policy_missing'
	| 'policy_expired'
	| 'policy_unverified'
	| 'subject_mismatch'
	| 'subject_unverifiable'
	| 'zdr_not_supported'
	| 'no_collection_not_supported';

export type GuardrailRouteEvidencePreview = {
	required: boolean;
	checkedCount: number;
	eligibleCount: number;
	excludedCount: number;
	excludedByReason: Partial<Record<GuardrailRouteEvidenceExclusionReason, number>>;
	eligibleExamples: Array<{
		modelId: string;
		provider: string;
		protocol: string;
		operation: string;
		routeGroup: string;
	}>;
};

export type GuardrailRouteEvidencePreviewResult = {
	value: GuardrailRouteEvidencePreview;
	/** Internal-only route set; callers must not serialize route ids or secrets. */
	eligibleRoutes: ModelRouteJoinRow[];
};

export type GuardrailBuiltinDetection = {
	slug: GuardrailDeterministicBuiltinSlug;
	action: GuardrailBuiltinAction;
	count: number;
};

export type GuardrailPreflightResult =
	| {
		ok: true;
		body: Record<string, unknown>;
		/** Validated, pinned filters that were applied to this request body. */
		inputFilters: GuardrailFilter[];
		outputFilters: GuardrailFilter[];
		hasInputGuardrails: boolean;
		builtinDetections: GuardrailBuiltinDetection[];
		flagCount: number;
		requireZdr: boolean;
		trace: GuardrailRuntimeTrace[];
		redactionCount: number;
		budgetIntents: GuardrailBudgetIntent[];
	}
	| {
		ok: false;
		status: 403 | 409;
		code: 'guardrail_blocked' | 'guardrail_invalid';
		message: string;
		trace: GuardrailRuntimeTrace[];
		blockedBuiltin?: GuardrailDeterministicBuiltinSlug;
	};

type ValidationResult =
	| { ok: true; value: GuardrailConfig; configJson: string }
	| { ok: false; message: string };

const FILTER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeStringList(value: unknown, field: string): { ok: true; value: string[] } | { ok: false; message: string } {
	if (!Array.isArray(value) || value.length > 64) {
		return { ok: false, message: `${field} must be an array of at most 64 values` };
	}
	const normalized: string[] = [];
	for (const item of value) {
		if (typeof item !== 'string' || !item.trim() || item.trim().length > 160) {
			return { ok: false, message: `${field} contains an invalid value` };
		}
		const trimmed = item.trim();
		if (!normalized.some((current) => current.toLowerCase() === trimmed.toLowerCase())) normalized.push(trimmed);
	}
	return { ok: true, value: normalized };
}

/**
 * Native JavaScript RegExp has no execution budget. Keep user-authored filters
 * in a deliberately small linear-time subset: no groups, lazy or unbounded
 * quantifiers, and at most one bounded repetition in each top-level
 * alternative. Fixed repetitions such as `{4}` remain available.
 */
function validateLinearRegexSubset(pattern: string): string | null {
	let inCharacterClass = false;
	let escaped = false;
	let variableQuantifiersInAlternative = 0;
	for (let index = 0; index < pattern.length; index += 1) {
		const character = pattern[index]!;
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === '\\') {
			escaped = true;
			continue;
		}
		if (character === '[') {
			inCharacterClass = true;
			continue;
		}
		if (character === ']' && inCharacterClass) {
			inCharacterClass = false;
			continue;
		}
		if (inCharacterClass) continue;

		if (character === '(' || character === ')') {
			return 'Filter patterns cannot use groups; use top-level alternatives or separate filters';
		}
		if (character === '|') {
			variableQuantifiersInAlternative = 0;
			continue;
		}
		if (character === '+' || character === '*') {
			return 'Filter patterns cannot use unbounded quantifiers; use a bounded {min,max} range';
		} else if (character === '?') {
			variableQuantifiersInAlternative += 1;
		} else if (character === '{') {
			const brace = /^\{(\d+)(?:,(\d*))?\}(\?)?/u.exec(pattern.slice(index));
			if (brace) {
				if (brace[3]) return 'Filter patterns cannot use lazy quantifiers';
				const minimum = Number(brace[1]);
				const maximum = brace[2] === undefined || brace[2] === brace[1]
					? minimum
					: brace[2] === '' ? null : Number(brace[2]);
				if (!Number.isSafeInteger(minimum) || maximum == null || !Number.isSafeInteger(maximum)) {
					return 'Filter patterns cannot use unbounded or unsafe brace quantifiers';
				}
				if (maximum < minimum) return 'Filter pattern brace quantifier bounds are invalid';
				if (minimum === maximum) {
					if (maximum > GUARDRAIL_MAX_EXACT_REPETITION) {
						return `Filter pattern exact quantifiers cannot exceed ${GUARDRAIL_MAX_EXACT_REPETITION}`;
					}
				} else {
					if (maximum > GUARDRAIL_MAX_BOUNDED_REPETITION) {
						return `Filter pattern bounded quantifiers cannot exceed ${GUARDRAIL_MAX_BOUNDED_REPETITION}`;
					}
					variableQuantifiersInAlternative += 1;
				}
				index += brace[0].length - 1;
			}
		}
		if (variableQuantifiersInAlternative > 1) {
			return 'Filter patterns can use at most one variable quantifier per top-level alternative';
		}
	}
	return null;
}

/** Reject constructs outside the conservative linear-time filter subset. */
export function validateGuardrailRegex(pattern: unknown): { ok: true; value: string } | { ok: false; message: string } {
	if (typeof pattern !== 'string' || !pattern || pattern.length > GUARDRAIL_MAX_PATTERN_LENGTH) {
		return { ok: false, message: `Filter pattern must contain 1-${GUARDRAIL_MAX_PATTERN_LENGTH} characters` };
	}
	if (/\(\?[=!<]/u.test(pattern)) return { ok: false, message: 'Filter patterns cannot use lookaround assertions' };
	if (/\\(?:[1-9]|k<)/u.test(pattern)) return { ok: false, message: 'Filter patterns cannot use backreferences' };
	const subsetError = validateLinearRegexSubset(pattern);
	if (subsetError) return { ok: false, message: subsetError };
	try {
		void new RegExp(pattern, 'giu');
	} catch {
		return { ok: false, message: 'Filter pattern is not a valid regular expression' };
	}
	return { ok: true, value: pattern };
}

function validateFilters(value: unknown, field: string): { ok: true; value: GuardrailFilter[] } | { ok: false; message: string } {
	if (!Array.isArray(value) || value.length > GUARDRAIL_MAX_FILTERS_PER_DIRECTION) {
		return { ok: false, message: `${field} must be an array of at most ${GUARDRAIL_MAX_FILTERS_PER_DIRECTION} filters` };
	}
	const ids = new Set<string>();
	const filters: GuardrailFilter[] = [];
	for (const item of value) {
		if (!isRecord(item) || typeof item.id !== 'string' || !FILTER_ID_PATTERN.test(item.id)) {
			return { ok: false, message: `${field} contains an invalid filter id` };
		}
		if (ids.has(item.id)) return { ok: false, message: `${field} contains duplicate filter id ${item.id}` };
		ids.add(item.id);
		if (item.action !== 'block' && item.action !== 'redact') {
			return { ok: false, message: `${field}.${item.id}.action must be block or redact` };
		}
		const pattern = validateGuardrailRegex(item.pattern);
		if (!pattern.ok) return { ok: false, message: `${field}.${item.id}: ${pattern.message}` };
		let label: string | undefined;
		if (item.label !== undefined) {
			if (typeof item.label !== 'string' || !item.label.trim() || item.label.trim().length > 200) {
				return { ok: false, message: `${field}.${item.id}.label must contain 1-200 characters` };
			}
			label = item.label.trim();
		}
		const unsupported = Object.keys(item).filter((key) => !['id', 'pattern', 'action', 'label'].includes(key));
		if (unsupported.length > 0) return { ok: false, message: `${field}.${item.id} contains unsupported fields: ${unsupported.join(', ')}` };
		filters.push({ id: item.id, pattern: pattern.value, action: item.action, ...(label ? { label } : {}) });
	}
	return { ok: true, value: filters };
}

function validateBuiltinFilters(
	value: unknown,
): { ok: true; value: GuardrailBuiltinFilter[] } | { ok: false; message: string } {
	if (!Array.isArray(value) || value.length > 16) {
		return { ok: false, message: 'content_filter_builtins must be an array of at most 16 filters' };
	}
	const slugs = new Set<string>();
	const filters: GuardrailBuiltinFilter[] = [];
	for (const [index, item] of value.entries()) {
		if (!isRecord(item)) return { ok: false, message: `content_filter_builtins[${index}] must be an object` };
		const unsupportedFields = Object.keys(item).filter((field) => field !== 'slug' && field !== 'action');
		if (unsupportedFields.length > 0) {
			return { ok: false, message: `content_filter_builtins[${index}] contains unsupported fields: ${unsupportedFields.join(', ')}` };
		}
		if (typeof item.slug !== 'string') return { ok: false, message: `content_filter_builtins[${index}].slug is required` };
		if ((GUARDRAIL_EXTERNAL_DETECTION_BUILTIN_SLUGS as readonly string[]).includes(item.slug)) {
			return { ok: false, message: `content_filter_builtins slug ${item.slug} requires an unavailable external detector` };
		}
		if (!(GUARDRAIL_DETERMINISTIC_BUILTIN_SLUGS as readonly string[]).includes(item.slug)) {
			return { ok: false, message: `content_filter_builtins[${index}].slug is unsupported` };
		}
		if (slugs.has(item.slug)) return { ok: false, message: `content_filter_builtins contains duplicate slug ${item.slug}` };
		slugs.add(item.slug);
		if (item.action !== 'block' && item.action !== 'redact' && item.action !== 'flag') {
			return { ok: false, message: `content_filter_builtins[${index}].action must be block, redact, or flag` };
		}
		if (item.action === 'flag' && item.slug !== 'regex-prompt-injection') {
			return { ok: false, message: 'flag is only available for regex-prompt-injection' };
		}
		filters.push({
			slug: item.slug as GuardrailDeterministicBuiltinSlug,
			action: item.action,
		});
	}
	return { ok: true, value: filters };
}

function validatePermissiveOpenRouterPolicy(
	value: unknown,
): { ok: true; value: NonNullable<GuardrailConfig['openrouter']> } | { ok: false; message: string } {
	if (!isRecord(value)) return { ok: false, message: 'openrouter must be an object' };
	const fields = [
		'enable_free_model_publication',
		'enable_free_model_training',
		'enable_paid_model_training',
	] as const;
	const unsupported = Object.keys(value).filter((key) => !fields.includes(key as typeof fields[number]));
	if (unsupported.length > 0) {
		return { ok: false, message: `openrouter contains unsupported fields: ${unsupported.join(', ')}` };
	}
	const result: NonNullable<GuardrailConfig['openrouter']> = {};
	for (const field of fields) {
		if (value[field] === undefined || value[field] === null) continue;
		if (value[field] !== true) {
			return {
				ok: false,
				message: `${field}=false is unavailable until endpoint training/publication evidence is enforced`,
			};
		}
		result[field] = true;
	}
	return { ok: true, value: result };
}

export function validateGuardrailConfig(input: unknown): ValidationResult {
	if (!isRecord(input)) return { ok: false, message: 'Guardrail config must be a JSON object' };
	const unsupported = Object.keys(input).filter((key) => ![
		'allowed_models', 'allowed_providers', 'ignored_models', 'ignored_providers',
		'input_filters', 'output_filters', 'content_filter_builtins', 'budget', 'data_collection', 'require_zdr', 'zdr', 'openrouter',
	].includes(key));
	if (unsupported.length > 0) return { ok: false, message: `Unsupported guardrail field(s): ${unsupported.join(', ')}` };
	const config: GuardrailConfig = {};
	if (input.allowed_models !== undefined) {
		const result = normalizeStringList(input.allowed_models, 'allowed_models');
		if (!result.ok) return result;
		config.allowed_models = result.value;
	}
	if (input.allowed_providers !== undefined) {
		const result = normalizeStringList(input.allowed_providers, 'allowed_providers');
		if (!result.ok) return result;
		config.allowed_providers = result.value;
	}
	if (input.ignored_models !== undefined) {
		const result = normalizeStringList(input.ignored_models, 'ignored_models');
		if (!result.ok) return result;
		config.ignored_models = result.value;
	}
	if (input.ignored_providers !== undefined) {
		const result = normalizeStringList(input.ignored_providers, 'ignored_providers');
		if (!result.ok) return result;
		config.ignored_providers = result.value;
	}
	if (input.input_filters !== undefined) {
		const result = validateFilters(input.input_filters, 'input_filters');
		if (!result.ok) return result;
		config.input_filters = result.value;
	}
	if (input.output_filters !== undefined) {
		const result = validateFilters(input.output_filters, 'output_filters');
		if (!result.ok) return result;
		config.output_filters = result.value;
	}
	if (input.content_filter_builtins !== undefined) {
		const result = validateBuiltinFilters(input.content_filter_builtins);
		if (!result.ok) return result;
		config.content_filter_builtins = result.value;
	}
	if (input.budget !== undefined) {
		if (!isRecord(input.budget) || typeof input.budget.limit !== 'number' || !Number.isFinite(input.budget.limit) || input.budget.limit <= 0 || input.budget.limit > 1_000_000_000) {
			return { ok: false, message: 'budget.limit must be a finite number greater than zero' };
		}
		if (!['daily', 'weekly', 'monthly'].includes(String(input.budget.period))) {
			return { ok: false, message: 'budget.period must be daily, weekly, or monthly' };
		}
		if (Object.keys(input.budget).some((key) => !['limit', 'period'].includes(key))) {
			return { ok: false, message: 'budget contains unsupported fields' };
		}
		const limitMicros = guardrailBudgetUnits(input.budget.limit);
		if (limitMicros <= 0) return { ok: false, message: 'budget.limit must be at least 0.000001' };
		config.budget = { limit: guardrailBudgetAmount(limitMicros), period: input.budget.period as GuardrailBudget['period'] };
	}
	if (input.data_collection !== undefined) {
		if (input.data_collection !== 'deny') {
			return { ok: false, message: 'data_collection can only be "deny"; omit it to use the default policy' };
		}
		config.data_collection = 'deny';
	}
	if (input.require_zdr !== undefined) {
		if (typeof input.require_zdr !== 'boolean') return { ok: false, message: 'require_zdr must be a boolean' };
		config.require_zdr = input.require_zdr;
	}
	if (input.zdr !== undefined) {
		if (!isRecord(input.zdr)) return { ok: false, message: 'zdr must be an object' };
		const allowed = ['anthropic', 'openai', 'google', 'xai', 'other'] as const;
		if (Object.keys(input.zdr).some((key) => !allowed.includes(key as typeof allowed[number]))) return { ok: false, message: 'zdr contains an unsupported model group' };
		const value: NonNullable<GuardrailConfig['zdr']> = {};
		for (const key of allowed) { if (input.zdr[key] !== undefined) { if (typeof input.zdr[key] !== 'boolean') return { ok: false, message: `zdr.${key} must be a boolean` }; value[key] = input.zdr[key] as boolean; } }
		config.zdr = value;
	}
	if (input.openrouter !== undefined) {
		const result = validatePermissiveOpenRouterPolicy(input.openrouter);
		if (!result.ok) return result;
		if (Object.keys(result.value).length > 0) config.openrouter = result.value;
	}
	const configJson = JSON.stringify(config);
	if (new TextEncoder().encode(configJson).byteLength > GUARDRAIL_MAX_CONFIG_BYTES) {
		return { ok: false, message: 'Guardrail config exceeds 64 KiB' };
	}
	return { ok: true, value: config, configJson };
}

/** Account-level policy is a ceiling, not an independent spending or DLP bucket. */
export function validateAccountDefaultGuardrailConfig(input: unknown) {
	const validated = validateGuardrailConfig(input);
	if (!validated.ok) return validated;
	const workspaceOnlyFields = [
		'budget',
		'input_filters',
		'output_filters',
		'content_filter_builtins',
		'openrouter',
	] as const;
	const unsupported = workspaceOnlyFields.filter((field) => validated.value[field] !== undefined);
	if (unsupported.length > 0) {
		return {
			ok: false as const,
			message: `Account Default Guardrail cannot configure workspace-only field(s): ${unsupported.join(', ')}`,
		};
	}
	return validated;
}

export async function saveGuardrailVersion(
	repositories: GatewayRepositories,
	params: { workspaceId: string; ownerUserId: string; id?: string; name: unknown; description?: unknown; config: unknown; preserveAdminManaged?: boolean },
): Promise<{ ok: true; guardrail: GuardrailWithVersionRow } | { ok: false; status: 400 | 403 | 404 | 409; message: string }> {
	const name = typeof params.name === 'string' ? params.name.trim() : '';
	if (!name || name.length > 128) return { ok: false, status: 400, message: 'Name must contain 1-128 characters' };
	let validated = validateGuardrailConfig(params.config);
	if (!validated.ok) return { ok: false, status: 400, message: validated.message };
	const description = typeof params.description === 'string' ? params.description.trim().slice(0, 1024) || null : null;
	const nowIso = new Date().toISOString();
	if (params.id) {
		const existing = await repositories.guardrails.getByIdInWorkspace(params.id, params.workspaceId);
		if (!existing) return { ok: false, status: 404, message: 'Guardrail not found' };
		if (existing.owner_user_id !== params.ownerUserId) return { ok: false, status: 403, message: 'Guardrail is owned by another user' };
		if (existing.status !== 'active') return { ok: false, status: 409, message: 'Archived guardrail cannot receive new versions' };
		if (existing.is_account_default) {
			validated = validateAccountDefaultGuardrailConfig(params.config);
			if (!validated.ok) return { ok: false, status: 400, message: validated.message };
		}
		const row = await repositories.guardrails.addVersion({
			guardrailId: existing.id, versionId: crypto.randomUUID(), name, description,
			configJson: validated.configJson, createdByUserId: params.ownerUserId, nowIso,
			preserveAdminManaged: params.preserveAdminManaged,
		});
		if (!row) {
			if (params.preserveAdminManaged && (await repositories.guardrails.listAssignments(existing.id)).some((assignment) => assignment.created_by_user_id === null)) {
				return { ok: false, status: 403, message: 'Administrator-managed guardrails are read-only' };
			}
			return { ok: false, status: 409, message: 'Guardrail changed while the version was being saved' };
		}
		return { ok: true, guardrail: (await repositories.guardrails.getById(existing.id)) ?? row };
	}
	return {
		ok: true,
		guardrail: await repositories.guardrails.createWithVersion({
			id: crypto.randomUUID(), versionId: crypto.randomUUID(), workspaceId: params.workspaceId,
			ownerUserId: params.ownerUserId,
			name, description, configJson: validated.configJson, createdByUserId: params.ownerUserId, nowIso,
		}),
	};
}

function periodBounds(period: GuardrailBudget['period'], now: Date): { start: string; end: string } {
	const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
	if (period === 'weekly') {
		const day = start.getUTCDay();
		start.setUTCDate(start.getUTCDate() - (day === 0 ? 6 : day - 1));
	} else if (period === 'monthly') {
		start.setUTCDate(1);
	}
	const end = new Date(start);
	if (period === 'daily') end.setUTCDate(end.getUTCDate() + 1);
	else if (period === 'weekly') end.setUTCDate(end.getUTCDate() + 7);
	else end.setUTCMonth(end.getUTCMonth() + 1);
	return { start: start.toISOString(), end: end.toISOString() };
}

function traceFor(row: EffectiveGuardrailRow): GuardrailRuntimeTrace {
	return {
		assignmentId: row.assignment_id, guardrailId: row.id, guardrailName: row.name,
		version: row.designated_version, scopeType: row.assignment_scope_type, scopeId: row.assignment_scope_id,
	};
}

function parseEffective(rows: EffectiveGuardrailRow[]): { ok: true; policies: { row: EffectiveGuardrailRow; config: GuardrailConfig }[] } | { ok: false; row: EffectiveGuardrailRow } {
	const policies: { row: EffectiveGuardrailRow; config: GuardrailConfig }[] = [];
	for (const row of rows) {
		try {
			const validated = validateGuardrailConfig(JSON.parse(row.version_config_json));
			if (!validated.ok) return { ok: false, row };
			if (row.assignment_scope_type === 'account') {
				const accountValidated = validateAccountDefaultGuardrailConfig(validated.value);
				if (!accountValidated.ok) return { ok: false, row };
			}
			policies.push({ row, config: validated.value });
		} catch {
			return { ok: false, row };
		}
	}
	return { ok: true, policies };
}

function inList(value: string, list: string[]): boolean {
	return list.some((item) => item.toLowerCase() === value.toLowerCase());
}

function modelGroup(modelId: string): 'anthropic' | 'openai' | 'google' | 'xai' | 'other' {
	const vendor = modelId.split('/', 1)[0]?.toLowerCase();
	if (vendor === 'anthropic') return 'anthropic';
	if (vendor === 'openai') return 'openai';
	if (vendor === 'google') return 'google';
	if (vendor === 'x-ai' || vendor === 'xai') return 'xai';
	return 'other';
}

function effectiveProviderAllowlist(lists: string[][]): string[] | null {
	if (lists.length === 0) return null;
	return lists.slice(1).reduce((current, next) => current.filter((item) => inList(item, next)), [...lists[0]!]);
}

function uniqueCaseInsensitive(values: readonly string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		const key = value.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(value);
	}
	return result;
}

function routeMatchesProviderSelector(route: ModelRouteJoinRow, selector: string): boolean {
	return route.provider_id.toLowerCase() === selector.toLowerCase()
		|| route.provider_name?.toLowerCase() === selector.toLowerCase();
}

function filterModelCandidates(
	body: Record<string, unknown>,
	modelIds: readonly string[],
	allowedLists: readonly string[][],
	ignored: readonly string[],
): string[] {
	const permitted = modelIds.filter((modelId) =>
		allowedLists.every((list) => inList(modelId, list))
		&& !inList(modelId, [...ignored]));
	if (permitted.length === modelIds.length) return permitted;
	body.model = permitted[0];
	if (Object.prototype.hasOwnProperty.call(body, 'fallbacks')) {
		if (permitted.length > 1) body.fallbacks = permitted.slice(1).map((model) => ({ model }));
		else delete body.fallbacks;
		delete body.models;
	} else if (Object.prototype.hasOwnProperty.call(body, 'models')) {
		if (permitted.length > 1) body.models = permitted.slice(1);
		else delete body.models;
	}
	return permitted;
}

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

const PROMPT_ROOT_KEYS = new Set([
	'messages',
	'input',
	'prompt',
	'system',
	'instructions',
	'query',
	'documents',
]);
const NON_CONTENT_KEYS = new Set(['type', 'role', 'name', 'id', 'model']);

function visitText(value: unknown, transform: (text: string) => string, depth = 0): unknown {
	if (depth > 24) return value;
	if (typeof value === 'string') return transform(value);
	if (Array.isArray(value)) return value.map((item) => visitText(item, transform, depth + 1));
	if (!isRecord(value)) return value;
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		result[key] = NON_CONTENT_KEYS.has(key) ? item : visitText(item, transform, depth + 1);
	}
	return result;
}

function promptBytes(body: Record<string, unknown>): number {
	let bytes = 0;
	for (const key of PROMPT_ROOT_KEYS) {
		if (body[key] !== undefined) bytes += new TextEncoder().encode(JSON.stringify(body[key])).byteLength;
	}
	return bytes;
}

function promptMatches(body: Record<string, unknown>, filter: GuardrailFilter): boolean {
	const regex = new RegExp(filter.pattern, 'iu');
	let matched = false;
	for (const key of PROMPT_ROOT_KEYS) {
		if (body[key] === undefined) continue;
		visitText(body[key], (text) => {
			if (regex.test(text)) matched = true;
			return text;
		});
	}
	return matched;
}

function redactPrompt(body: Record<string, unknown>, filter: GuardrailFilter): number {
	const regex = new RegExp(filter.pattern, 'giu');
	let count = 0;
	for (const key of PROMPT_ROOT_KEYS) {
		if (body[key] === undefined) continue;
		body[key] = visitText(body[key], (text) => text.replace(regex, () => {
			count += 1;
			return filter.label ?? `[REDACTED:${filter.id}]`;
		}));
	}
	return count;
}

const BUILTIN_ACTION_RANK: Readonly<Record<GuardrailBuiltinAction, number>> = {
	flag: 1,
	redact: 2,
	block: 3,
};

const BUILTIN_REDACTION_ORDER: readonly GuardrailDeterministicBuiltinSlug[] = [
	'secrets',
	'credit-card',
	'ssn',
	'email',
	'ip-address',
	'phone',
	'regex-prompt-injection',
];

function effectiveBuiltinFilters(
	policies: readonly { config: GuardrailConfig }[],
): GuardrailBuiltinFilter[] {
	const actions = new Map<GuardrailDeterministicBuiltinSlug, GuardrailBuiltinAction>();
	for (const { config } of policies) {
		for (const filter of config.content_filter_builtins ?? []) {
			const current = actions.get(filter.slug);
			if (!current || BUILTIN_ACTION_RANK[filter.action] > BUILTIN_ACTION_RANK[current]) {
				actions.set(filter.slug, filter.action);
			}
		}
	}
	return BUILTIN_REDACTION_ORDER.flatMap((slug) => {
		const action = actions.get(slug);
		return action ? [{ slug, action }] : [];
	});
}

const GUARDRAIL_PREVIEW_MAX_IDENTITIES = 200;
const GUARDRAIL_PREVIEW_MAX_EXAMPLES = 100;

/**
 * Build a read-only explanation from the same pinned Guardrail versions used
 * by request enforcement. The route list intentionally stops at identity
 * policy: ZDR and no-collection eligibility is re-proved against the current
 * endpoint subject at dispatch and is never inferred by this preview.
 */
export function buildEffectiveGuardrailPreview(
	rows: readonly EffectiveGuardrailRow[],
	routes: readonly ModelRouteJoinRow[],
	options: { catalogTruncated?: boolean } = {},
): GuardrailEffectivePreviewResult {
	const trace = rows.map(traceFor);
	const parsed = parseEffective([...rows]);
	if (!parsed.ok) {
		return {
			ok: false,
			trace,
			message: `Guardrail ${parsed.row.id} has an invalid designated version`,
		};
	}

	const modelAllowlists = parsed.policies.flatMap(({ config }) =>
		config.allowed_models?.length ? [config.allowed_models] : []);
	const providerAllowlists = parsed.policies.flatMap(({ config }) =>
		config.allowed_providers?.length ? [config.allowed_providers] : []);
	const allowedModels = modelAllowlists.length === 0
		? null
		: modelAllowlists.slice(1).reduce(
			(current, next) => current.filter((model) => inList(model, next)),
			[...modelAllowlists[0]!],
		);
	const allowedProviders = effectiveProviderAllowlist(providerAllowlists);
	const ignoredModels = uniqueCaseInsensitive(
		parsed.policies.flatMap(({ config }) => config.ignored_models ?? []),
	);
	const ignoredProviders = uniqueCaseInsensitive(
		parsed.policies.flatMap(({ config }) => config.ignored_providers ?? []),
	);
	const dataCollection = parsed.policies.some(({ config }) => config.data_collection === 'deny')
		? 'deny' as const
		: null;
	const requireZdr = parsed.policies.some(({ config }) => config.require_zdr === true);
	const zdr = {
		anthropic: parsed.policies.some(({ config }) => config.zdr?.anthropic === true),
		openai: parsed.policies.some(({ config }) => config.zdr?.openai === true),
		google: parsed.policies.some(({ config }) => config.zdr?.google === true),
		xai: parsed.policies.some(({ config }) => config.zdr?.xai === true),
		other: parsed.policies.some(({ config }) => config.zdr?.other === true),
	};

	const candidates = routes.filter((route) => {
		if (route.status !== 'active') return false;
		if (route.route_pool_id != null && route.pool_status !== 'active') return false;
		if (route.provider_status !== 'active') return false;
		if (allowedModels && !inList(route.model_id, allowedModels)) return false;
		if (inList(route.model_id, ignoredModels)) return false;
		if (allowedProviders
			&& !allowedProviders.some((selector) => routeMatchesProviderSelector(route, selector))) return false;
		if (ignoredProviders.some((selector) => routeMatchesProviderSelector(route, selector))) return false;
		return true;
	}).sort((left, right) =>
		left.model_id.localeCompare(right.model_id)
		|| (left.provider_name ?? left.provider_id).localeCompare(right.provider_name ?? right.provider_id)
		|| left.upstream_protocol.localeCompare(right.upstream_protocol)
		|| left.upstream_operation.localeCompare(right.upstream_operation)
		|| left.route_group.localeCompare(right.route_group));
	const allModelIds = uniqueCaseInsensitive(candidates.map((route) => route.model_id));
	const allProviders = uniqueCaseInsensitive(candidates.map((route) => route.provider_name ?? route.provider_id));
	const modelIds = allModelIds.slice(0, GUARDRAIL_PREVIEW_MAX_IDENTITIES);
	const providers = allProviders.slice(0, GUARDRAIL_PREVIEW_MAX_IDENTITIES);
	const examples = candidates.slice(0, GUARDRAIL_PREVIEW_MAX_EXAMPLES).map((route) => ({
		modelId: route.model_id,
		provider: route.provider_name ?? route.provider_id,
		protocol: route.upstream_protocol,
		operation: route.upstream_operation,
		routeGroup: route.route_group,
	}));

	return {
		ok: true,
		candidateRoutes: candidates,
		value: {
			trace,
			effective: {
				allowedModels,
				ignoredModels,
				allowedProviders,
				ignoredProviders,
				dataCollection,
				requireZdr,
				zdr,
				contentFilterBuiltins: effectiveBuiltinFilters(parsed.policies),
				inputFilters: parsed.policies.flatMap(({ config }) =>
					(config.input_filters ?? []).map(({ id, action, label }) => ({ id, action, ...(label ? { label } : {}) }))),
				outputFilters: parsed.policies.flatMap(({ config }) =>
					(config.output_filters ?? []).map(({ id, action, label }) => ({ id, action, ...(label ? { label } : {}) }))),
				budgets: parsed.policies.flatMap(({ row, config }) => config.budget ? [{
					guardrailId: row.id,
					guardrailName: row.name,
					version: row.designated_version,
					scopeType: row.assignment_scope_type,
					scopeId: row.assignment_scope_id,
					limit: config.budget.limit,
					period: config.budget.period,
				}] : []),
			},
			routeCandidates: {
				count: candidates.length,
				modelIds,
				providers,
				examples,
				truncated: options.catalogTruncated === true
					|| examples.length < candidates.length
					|| modelIds.length < allModelIds.length
					|| providers.length < allProviders.length,
				requiresEndpointEvidence: requireZdr || Object.values(zdr).some(Boolean) || dataCollection === 'deny',
			},
		},
	};
}

function publicPreviewRoute(route: ModelRouteJoinRow) {
	return {
		modelId: route.model_id,
		provider: route.provider_name ?? route.provider_id,
		protocol: route.upstream_protocol,
		operation: route.upstream_operation,
		routeGroup: route.route_group,
	};
}

/**
 * Re-prove the privacy-policy portion of candidate eligibility against the
 * current Route + Provider credential subject. Raw credentials and subject
 * fingerprints are consumed only to make the decision and never returned.
 */
export async function evaluateGuardrailRouteEvidencePreviewWithRoutes(params: {
	effective: GuardrailEffectivePreview['effective'];
	candidateRoutes: readonly ModelRouteJoinRow[];
	providers: readonly ProviderRow[];
	policies: readonly RouteDataPolicyRow[];
	now?: Date;
}): Promise<GuardrailRouteEvidencePreviewResult> {
	const required = params.effective.requireZdr
		|| Object.values(params.effective.zdr).some(Boolean)
		|| params.effective.dataCollection === 'deny';
	if (!required) {
		return {
			eligibleRoutes: [...params.candidateRoutes],
			value: {
				required: false,
				checkedCount: params.candidateRoutes.length,
				eligibleCount: params.candidateRoutes.length,
				excludedCount: 0,
				excludedByReason: {},
				eligibleExamples: params.candidateRoutes.slice(0, GUARDRAIL_PREVIEW_MAX_EXAMPLES).map(publicPreviewRoute),
			},
		};
	}

	const providerById = new Map(params.providers.map((provider) => [provider.id, provider]));
	const policyByTargetId = new Map(params.policies.map((policy) => [policy.route_target_id, policy]));
	const excludedByReason: Partial<Record<GuardrailRouteEvidenceExclusionReason, number>> = {};
	const eligible: ModelRouteJoinRow[] = [];
	const now = params.now ?? new Date();
	const exclude = (reason: GuardrailRouteEvidenceExclusionReason) => {
		excludedByReason[reason] = (excludedByReason[reason] ?? 0) + 1;
	};

	for (const route of params.candidateRoutes) {
		const requireZdr = params.effective.requireZdr || params.effective.zdr[modelGroup(route.model_id)];
		const requireNoCollection = params.effective.dataCollection === 'deny';
		if (!requireZdr && !requireNoCollection) {
			eligible.push(route);
			continue;
		}
		const provider = providerById.get(route.provider_id);
		if (!provider || provider.status !== 'active') {
			exclude('provider_missing');
			continue;
		}
		if (provider.shared_channel_type != null) {
			exclude('shared_channel');
			continue;
		}
		const policy = policyByTargetId.get(route.id);
		if (!policy) {
			exclude('policy_missing');
			continue;
		}
		let subjectFingerprint: string;
		try {
			subjectFingerprint = await computeRouteDataPolicySubjectFingerprintFromRows(route, provider);
		} catch {
			exclude('subject_unverifiable');
			continue;
		}
		const status = effectiveRouteDataPolicyStatus(policy, now);
		if (status === 'expired') {
			exclude('policy_expired');
			continue;
		}
		if (status !== 'verified') {
			exclude('policy_unverified');
			continue;
		}
		if (!routeDataPolicySubjectMatches(policy, subjectFingerprint)) {
			exclude('subject_mismatch');
			continue;
		}
		if (requireZdr && !routeDataPolicyAllowsZdr(policy, subjectFingerprint, now)) {
			exclude('zdr_not_supported');
			continue;
		}
		if (requireNoCollection && !routeDataPolicyDeniesCollection(policy, subjectFingerprint, now)) {
			exclude('no_collection_not_supported');
			continue;
		}
		eligible.push(route);
	}

	return {
		eligibleRoutes: eligible,
		value: {
			required: true,
			checkedCount: params.candidateRoutes.length,
			eligibleCount: eligible.length,
			excludedCount: params.candidateRoutes.length - eligible.length,
			excludedByReason,
			eligibleExamples: eligible.slice(0, GUARDRAIL_PREVIEW_MAX_EXAMPLES).map(publicPreviewRoute),
		},
	};
}

export async function evaluateGuardrailRouteEvidencePreview(params: {
	effective: GuardrailEffectivePreview['effective'];
	candidateRoutes: readonly ModelRouteJoinRow[];
	providers: readonly ProviderRow[];
	policies: readonly RouteDataPolicyRow[];
	now?: Date;
}): Promise<GuardrailRouteEvidencePreview> {
	return (await evaluateGuardrailRouteEvidencePreviewWithRoutes(params)).value;
}

function promptBuiltinMatchCount(
	body: Record<string, unknown>,
	filter: GuardrailBuiltinFilter,
): number {
	let count = 0;
	for (const key of PROMPT_ROOT_KEYS) {
		if (body[key] === undefined) continue;
		visitText(body[key], (text) => {
			count += detectGuardrailBuiltin(text, filter.slug).length;
			return text;
		});
	}
	return count;
}

function redactPromptBuiltin(
	body: Record<string, unknown>,
	filter: GuardrailBuiltinFilter,
): number {
	let count = 0;
	for (const key of PROMPT_ROOT_KEYS) {
		if (body[key] === undefined) continue;
		body[key] = visitText(body[key], (text) => {
			const redacted = redactGuardrailBuiltin(text, filter.slug);
			count += redacted.count;
			return redacted.value;
		});
	}
	return count;
}

function blockedBuiltinMessage(slug: GuardrailDeterministicBuiltinSlug): string {
	return slug === 'regex-prompt-injection'
		? 'Request blocked: prompt injection patterns detected'
		: `Request blocked by content filter: ${guardrailBuiltinPublicLabel(slug)}`;
}

export async function enforceRequestGuardrails(
	repositories: GatewayRepositories,
	params: { workspaceId: string; userId: string; apiKeyId: string; modelIds: string[]; body: Record<string, unknown>; now?: Date },
): Promise<GuardrailPreflightResult> {
	const rows = await repositories.guardrails.getEffectiveForRequest(params.workspaceId, params.userId, params.apiKeyId);
	if (rows.length === 0) return {
		ok: true,
		body: params.body,
		inputFilters: [],
		outputFilters: [],
		hasInputGuardrails: false,
		builtinDetections: [],
		flagCount: 0,
		requireZdr: false,
		trace: [],
		redactionCount: 0,
		budgetIntents: [],
	};
	const trace = rows.map(traceFor);
	const parsed = parseEffective(rows);
	if (!parsed.ok) return { ok: false, status: 409, code: 'guardrail_invalid', message: 'An assigned guardrail version is invalid', trace };

	const body = cloneJson(params.body);
	const modelAllowlists = parsed.policies.flatMap(({ config }) => config.allowed_models?.length ? [config.allowed_models] : []);
	const ignoredModels = parsed.policies.flatMap(({ config }) => config.ignored_models ?? []);
	const permittedModels = filterModelCandidates(body, params.modelIds, modelAllowlists, ignoredModels);
	if (permittedModels.length === 0) {
		return { ok: false, status: 403, code: 'guardrail_blocked', message: 'Request blocked by model policy', trace };
	}
	const evaluatedAt = params.now ?? new Date();
	const budgetIntents: GuardrailBudgetIntent[] = parsed.policies.flatMap(({ row, config }) => {
		if (!config.budget) return [];
		if (row.assignment_scope_type === 'account') return [];
		const bounds = periodBounds(config.budget.period, evaluatedAt);
		const common = {
			workspaceId: params.workspaceId,
			guardrailId: row.id,
			guardrailVersion: row.designated_version,
			period: config.budget.period,
			periodStart: bounds.start,
			periodEnd: bounds.end,
			limitMicros: guardrailBudgetUnits(config.budget.limit),
		};
		if (row.assignment_scope_type === 'workspace') {
			return [
				{
					...common,
					assignmentId: `${row.assignment_id}:user`,
					scopeType: 'user' as const,
					scopeId: params.userId,
				},
				{
					...common,
					assignmentId: `${row.assignment_id}:api-key`,
					scopeType: 'api_key' as const,
					scopeId: params.apiKeyId,
				},
			];
		}
		return [{
			...common,
			assignmentId: row.assignment_id,
			scopeType: row.assignment_scope_type,
			scopeId: row.assignment_scope_id,
		}];
	});

	const providerLists = parsed.policies.flatMap(({ config }) => config.allowed_providers?.length ? [config.allowed_providers] : []);
	const ignoredProviders = parsed.policies.flatMap(({ config }) => config.ignored_providers ?? []);
	const denyDataCollection = parsed.policies.some(({ config }) => config.data_collection === 'deny');
	const allowedProviders = effectiveProviderAllowlist(providerLists);
	const providers = allowedProviders?.filter((provider) => !inList(provider, ignoredProviders)) ?? null;
	if (providers && providers.length === 0) {
		return { ok: false, status: 403, code: 'guardrail_blocked', message: 'Request blocked by provider policy', trace };
	}
	if (providers) {
		const current = isRecord(body.provider) ? { ...body.provider } : {};
		const requestedOnly = Array.isArray(current.only) ? current.only.filter((item): item is string => typeof item === 'string') : null;
		const only = requestedOnly ? providers.filter((provider) => inList(provider, requestedOnly)) : providers;
		if (only.length === 0) return { ok: false, status: 403, code: 'guardrail_blocked', message: 'Request blocked by provider policy', trace };
		current.only = only;
		body.provider = current;
	} else if (ignoredProviders.length > 0) {
		const current = isRecord(body.provider) ? { ...body.provider } : {};
		const callerIgnored = Array.isArray(current.ignore)
			? current.ignore.filter((item): item is string => typeof item === 'string')
			: [];
		current.ignore = [...callerIgnored, ...ignoredProviders].filter((value, index, values) =>
			values.findIndex((candidate) => candidate.toLowerCase() === value.toLowerCase()) === index);
		body.provider = current;
	}
	if (denyDataCollection) {
		const current = isRecord(body.provider) ? { ...body.provider } : {};
		current.data_collection = 'deny';
		body.provider = current;
	}

	if (promptBytes(body) > GUARDRAIL_MAX_SCANNED_TEXT_BYTES) {
		return { ok: false, status: 403, code: 'guardrail_blocked', message: 'Request content exceeds the guardrail scan limit', trace };
	}
	const inputFilters = parsed.policies.flatMap(({ config }) => config.input_filters ?? []);
	const builtinFilters = effectiveBuiltinFilters(parsed.policies);
	for (const filter of builtinFilters.filter((item) => item.action === 'block')) {
		if (promptBuiltinMatchCount(body, filter) > 0) {
			return {
				ok: false,
				status: 403,
				code: 'guardrail_blocked',
				message: blockedBuiltinMessage(filter.slug),
				trace,
				blockedBuiltin: filter.slug,
			};
		}
	}
	for (const filter of inputFilters.filter((item) => item.action === 'block')) {
		if (promptMatches(body, filter)) return { ok: false, status: 403, code: 'guardrail_blocked', message: `Request blocked by input filter ${filter.id}`, trace };
	}
	const builtinDetections: GuardrailBuiltinDetection[] = [];
	let flagCount = 0;
	for (const filter of builtinFilters.filter((item) => item.action === 'flag')) {
		const count = promptBuiltinMatchCount(body, filter);
		if (count === 0) continue;
		flagCount += count;
		builtinDetections.push({ ...filter, count });
	}
	let redactionCount = 0;
	for (const filter of builtinFilters.filter((item) => item.action === 'redact')) {
		const count = redactPromptBuiltin(body, filter);
		if (count === 0) continue;
		redactionCount += count;
		builtinDetections.push({ ...filter, count });
	}
	for (const filter of inputFilters.filter((item) => item.action === 'redact')) redactionCount += redactPrompt(body, filter);
	const outputFilters = parsed.policies.flatMap(({ config }) => config.output_filters ?? []);
	if (outputFilters.length > 0 && body.stream === true) {
		return { ok: false, status: 403, code: 'guardrail_blocked', message: 'Streaming is disabled when output guardrails are active', trace };
	}
	const requireZdr = parsed.policies.some(({ config }) => config.require_zdr === true || permittedModels.some((modelId) => config.zdr?.[modelGroup(modelId)] === true));
	if (requireZdr) {
		const provider = isRecord(body.provider) ? { ...body.provider } : {};
		provider.zdr = true;
		body.provider = provider;
	}
	return {
		ok: true,
		body,
		inputFilters,
		outputFilters,
		hasInputGuardrails: inputFilters.length > 0 || builtinFilters.length > 0,
		builtinDetections,
		flagCount,
		requireZdr,
		trace,
		redactionCount,
		budgetIntents,
	};
}

export function applyGuardrailFiltersToJson(value: unknown, filters: GuardrailFilter[]): { blockedBy: string | null; value: unknown; redactionCount: number } {
	for (const filter of filters.filter((item) => item.action === 'block')) {
		const regex = new RegExp(filter.pattern, 'iu');
		let matched = false;
		visitText(value, (text) => {
			if (regex.test(text)) matched = true;
			return text;
		});
		if (matched) return { blockedBy: filter.id, value: null, redactionCount: 0 };
	}
	let result = cloneJson(value);
	let redactionCount = 0;
	for (const filter of filters.filter((item) => item.action === 'redact')) {
		const regex = new RegExp(filter.pattern, 'giu');
		result = visitText(result, (text) => text.replace(regex, () => {
			redactionCount += 1;
			return filter.label ?? `[REDACTED:${filter.id}]`;
		}));
	}
	return { blockedBy: null, value: result, redactionCount };
}
