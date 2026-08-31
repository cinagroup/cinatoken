import type { GatewayRepositories } from './storage/repositories-types';
import type {
	EffectiveGuardrailRow,
	GuardrailScopeType,
	GuardrailWithVersionRow,
} from './db/guardrails-types';
import {
	guardrailBudgetAmount,
	guardrailBudgetUnits,
	type GuardrailBudgetIntent,
	type GuardrailBudgetPeriod,
} from './db/guardrail-budget-types';

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
};
export type GuardrailBudget = {
	limit: number;
	period: GuardrailBudgetPeriod;
};
export type GuardrailConfig = {
	allowed_models?: string[];
	allowed_providers?: string[];
	input_filters?: GuardrailFilter[];
	output_filters?: GuardrailFilter[];
	budget?: GuardrailBudget;
	require_zdr?: boolean;
	zdr?: Partial<Record<'anthropic' | 'openai' | 'google' | 'xai' | 'other', boolean>>;
};

export type GuardrailRuntimeTrace = {
	assignmentId: string;
	guardrailId: string;
	guardrailName: string;
	version: number;
	scopeType: GuardrailScopeType;
	scopeId: string;
};

export type GuardrailPreflightResult =
	| {
		ok: true;
		body: Record<string, unknown>;
		/** Validated, pinned filters that were applied to this request body. */
		inputFilters: GuardrailFilter[];
		outputFilters: GuardrailFilter[];
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
		const unsupported = Object.keys(item).filter((key) => !['id', 'pattern', 'action'].includes(key));
		if (unsupported.length > 0) return { ok: false, message: `${field}.${item.id} contains unsupported fields: ${unsupported.join(', ')}` };
		filters.push({ id: item.id, pattern: pattern.value, action: item.action });
	}
	return { ok: true, value: filters };
}

export function validateGuardrailConfig(input: unknown): ValidationResult {
	if (!isRecord(input)) return { ok: false, message: 'Guardrail config must be a JSON object' };
	const unsupported = Object.keys(input).filter((key) => ![
		'allowed_models', 'allowed_providers', 'input_filters', 'output_filters', 'budget', 'require_zdr', 'zdr',
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
	const configJson = JSON.stringify(config);
	if (new TextEncoder().encode(configJson).byteLength > GUARDRAIL_MAX_CONFIG_BYTES) {
		return { ok: false, message: 'Guardrail config exceeds 64 KiB' };
	}
	return { ok: true, value: config, configJson };
}

export async function saveGuardrailVersion(
	repositories: GatewayRepositories,
	params: { workspaceId: string; ownerUserId: string; id?: string; name: unknown; description?: unknown; config: unknown; preserveAdminManaged?: boolean },
): Promise<{ ok: true; guardrail: GuardrailWithVersionRow } | { ok: false; status: 400 | 403 | 404 | 409; message: string }> {
	const name = typeof params.name === 'string' ? params.name.trim() : '';
	if (!name || name.length > 128) return { ok: false, status: 400, message: 'Name must contain 1-128 characters' };
	const validated = validateGuardrailConfig(params.config);
	if (!validated.ok) return { ok: false, status: 400, message: validated.message };
	const description = typeof params.description === 'string' ? params.description.trim().slice(0, 1024) || null : null;
	const nowIso = new Date().toISOString();
	if (params.id) {
		const existing = await repositories.guardrails.getByIdInWorkspace(params.id, params.workspaceId);
		if (!existing) return { ok: false, status: 404, message: 'Guardrail not found' };
		if (existing.owner_user_id !== params.ownerUserId) return { ok: false, status: 403, message: 'Guardrail is owned by another user' };
		if (existing.status !== 'active') return { ok: false, status: 409, message: 'Archived guardrail cannot receive new versions' };
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

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

const PROMPT_ROOT_KEYS = new Set(['messages', 'input', 'prompt', 'system', 'instructions']);
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
			return `[REDACTED:${filter.id}]`;
		}));
	}
	return count;
}

export async function enforceRequestGuardrails(
	repositories: GatewayRepositories,
	params: { workspaceId: string; userId: string; apiKeyId: string; modelIds: string[]; body: Record<string, unknown>; now?: Date },
): Promise<GuardrailPreflightResult> {
	const rows = await repositories.guardrails.getEffectiveForRequest(params.workspaceId, params.userId, params.apiKeyId);
	if (rows.length === 0) return { ok: true, body: params.body, inputFilters: [], outputFilters: [], requireZdr: false, trace: [], redactionCount: 0, budgetIntents: [] };
	const trace = rows.map(traceFor);
	const parsed = parseEffective(rows);
	if (!parsed.ok) return { ok: false, status: 409, code: 'guardrail_invalid', message: 'An assigned guardrail version is invalid', trace };

	for (const { config } of parsed.policies) {
		if (config.allowed_models?.length && params.modelIds.some((model) => !inList(model, config.allowed_models!))) {
			return { ok: false, status: 403, code: 'guardrail_blocked', message: 'Request blocked by model policy', trace };
		}
	}
	const evaluatedAt = params.now ?? new Date();
	const budgetIntents: GuardrailBudgetIntent[] = parsed.policies.flatMap(({ row, config }) => {
		if (!config.budget) return [];
		const bounds = periodBounds(config.budget.period, evaluatedAt);
		return [{
			workspaceId: params.workspaceId,
			assignmentId: row.assignment_id,
			guardrailId: row.id,
			guardrailVersion: row.designated_version,
			scopeType: row.assignment_scope_type,
			scopeId: row.assignment_scope_id,
			period: config.budget.period,
			periodStart: bounds.start,
			periodEnd: bounds.end,
			limitMicros: guardrailBudgetUnits(config.budget.limit),
		}];
	});

	const providerLists = parsed.policies.flatMap(({ config }) => config.allowed_providers?.length ? [config.allowed_providers] : []);
	const providers = effectiveProviderAllowlist(providerLists);
	if (providers && providers.length === 0) {
		return { ok: false, status: 403, code: 'guardrail_blocked', message: 'Request blocked by provider policy', trace };
	}
	const body = cloneJson(params.body);
	if (providers) {
		const current = isRecord(body.provider) ? { ...body.provider } : {};
		const requestedOnly = Array.isArray(current.only) ? current.only.filter((item): item is string => typeof item === 'string') : null;
		const only = requestedOnly ? providers.filter((provider) => inList(provider, requestedOnly)) : providers;
		if (only.length === 0) return { ok: false, status: 403, code: 'guardrail_blocked', message: 'Request blocked by provider policy', trace };
		current.only = only;
		body.provider = current;
	}

	if (promptBytes(body) > GUARDRAIL_MAX_SCANNED_TEXT_BYTES) {
		return { ok: false, status: 403, code: 'guardrail_blocked', message: 'Request content exceeds the guardrail scan limit', trace };
	}
	const inputFilters = parsed.policies.flatMap(({ config }) => config.input_filters ?? []);
	for (const filter of inputFilters.filter((item) => item.action === 'block')) {
		if (promptMatches(body, filter)) return { ok: false, status: 403, code: 'guardrail_blocked', message: `Request blocked by input filter ${filter.id}`, trace };
	}
	let redactionCount = 0;
	for (const filter of inputFilters.filter((item) => item.action === 'redact')) redactionCount += redactPrompt(body, filter);
	const outputFilters = parsed.policies.flatMap(({ config }) => config.output_filters ?? []);
	if (outputFilters.length > 0 && body.stream === true) {
		return { ok: false, status: 403, code: 'guardrail_blocked', message: 'Streaming is disabled when output guardrails are active', trace };
	}
	const requireZdr = parsed.policies.some(({ config }) => config.require_zdr === true || params.modelIds.some((modelId) => config.zdr?.[modelGroup(modelId)] === true));
	if (requireZdr) {
		const provider = isRecord(body.provider) ? { ...body.provider } : {};
		provider.zdr = true;
		body.provider = provider;
	}
	return { ok: true, body, inputFilters, outputFilters, requireZdr, trace, redactionCount, budgetIntents };
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
			return `[REDACTED:${filter.id}]`;
		}));
	}
	return { blockedBy: null, value: result, redactionCount };
}
