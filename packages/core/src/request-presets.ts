import type { GatewayRepositories } from './storage/repositories-types';
import type {
	RequestPresetVersionRow,
	RequestPresetVisibility,
	RequestPresetWithVersionRow,
} from './db/request-presets-types';

export const REQUEST_PRESET_MAX_CONFIG_BYTES = 64 * 1024;
export const REQUEST_PRESET_MAX_SYSTEM_PROMPT_BYTES = 32 * 1024;

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const TRANSIENT_FIELDS = new Set([
	'messages', 'input', 'prompt', 'stream', 'system', 'instructions', 'preset',
	'background', 'debug', 'metadata', 'previous_response_id', 'prompt_cache_key',
	'safety_identifier', 'session_id', 'store', 'trace', 'user',
]);
const ALLOWED_CONFIG_FIELDS = new Set([
	'model', 'models', 'provider', 'tools', 'tool_choice', 'parallel_tool_calls',
	'temperature', 'top_p', 'top_k', 'min_p', 'top_a', 'frequency_penalty',
	'presence_penalty', 'repetition_penalty', 'max_tokens', 'max_completion_tokens',
	'max_output_tokens', 'max_tool_calls', 'stop', 'stop_sequences', 'seed',
	'response_format', 'structured_outputs', 'reasoning', 'reasoning_effort',
	'verbosity', 'logit_bias', 'logprobs', 'top_logprobs', 'modalities',
	'image_config', 'audio', 'cache_control', 'context_management', 'fallbacks',
	'output_config', 'plugins', 'thinking', 'stop_server_tools_when', 'text',
	'truncation', 'route_group', 'service_tier', 'speed',
]);
const FORBIDDEN_NESTED_KEYS = new Set([
	'api_key', 'apikey', 'authorization', 'headers', 'base_url', 'baseurl',
	'endpoint_url', 'secret', 'token', 'password',
]);

export type RequestPresetProtocol = 'chat' | 'messages' | 'responses';

export type PresetConfigValidationResult =
	| { ok: true; value: Record<string, unknown>; configJson: string }
	| { ok: false; message: string };

export type PresetResolutionResult =
	| { ok: true; body: Record<string, unknown>; preset: RequestPresetWithVersionRow | null }
	| { ok: false; status: 400 | 403 | 404 | 409; code: string; message: string };

export function normalizeRequestPresetSlug(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const slug = value.trim().toLowerCase().replace(/^@preset\//, '');
	return SLUG_PATTERN.test(slug) ? slug : null;
}

function walkJson(value: unknown, depth: number, state: { nodes: number }): string | null {
	if (depth > 10) return 'Preset config exceeds the maximum nesting depth';
	state.nodes += 1;
	if (state.nodes > 4096) return 'Preset config contains too many values';
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return null;
	if (typeof value === 'number') return Number.isFinite(value) ? null : 'Preset config contains a non-finite number';
	if (Array.isArray(value)) {
		if (value.length > 512) return 'Preset config contains an oversized array';
		for (const item of value) {
			const error = walkJson(item, depth + 1, state);
			if (error) return error;
		}
		return null;
	}
	if (typeof value !== 'object') return 'Preset config contains an unsupported value';
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (FORBIDDEN_NESTED_KEYS.has(key.toLowerCase())) return `Preset config cannot contain ${key}`;
		const error = walkJson(item, depth + 1, state);
		if (error) return error;
	}
	return null;
}

export function validateRequestPresetConfig(input: unknown): PresetConfigValidationResult {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		return { ok: false, message: 'Preset config must be a JSON object' };
	}
	const config = { ...(input as Record<string, unknown>) };
	for (const key of Object.keys(config)) {
		if (TRANSIENT_FIELDS.has(key)) return { ok: false, message: `Preset config cannot persist transient field ${key}` };
		if (!ALLOWED_CONFIG_FIELDS.has(key)) return { ok: false, message: `Unsupported preset config field ${key}` };
	}
	if (typeof config.model === 'string' && config.model.includes('@preset/')) {
		return { ok: false, message: 'Preset config cannot reference another preset' };
	}
	if (config.provider !== undefined) {
		if (!config.provider || typeof config.provider !== 'object' || Array.isArray(config.provider)) {
			return { ok: false, message: 'provider must be an object' };
		}
		const provider = config.provider as Record<string, unknown>;
		const supported = new Set([
			'order', 'only', 'ignore', 'allow_fallbacks', 'zdr', 'require_parameters',
			'data_collection', 'enforce_distillable_text', 'quantizations', 'sort',
			'preferred_min_throughput', 'preferred_max_latency', 'max_price',
		]);
		const unsupported = Object.keys(provider).filter((key) => !supported.has(key));
		if (unsupported.length > 0) return { ok: false, message: `Unsupported provider preference: ${unsupported.join(', ')}` };
		for (const key of ['order', 'only', 'ignore'] as const) {
			if (provider[key] === undefined) continue;
			if (!Array.isArray(provider[key]) || provider[key].length > 32 || provider[key].some((item) => typeof item !== 'string' || !item.trim() || item.length > 120)) {
				return { ok: false, message: `provider.${key} must contain at most 32 provider names` };
			}
		}
		for (const key of ['allow_fallbacks', 'zdr', 'require_parameters', 'enforce_distillable_text'] as const) {
			if (provider[key] !== undefined && typeof provider[key] !== 'boolean') {
				return { ok: false, message: `provider.${key} must be a boolean` };
			}
		}
		if (provider.data_collection !== undefined && provider.data_collection !== 'allow' && provider.data_collection !== 'deny') {
			return { ok: false, message: 'provider.data_collection must be allow or deny' };
		}
		if (provider.sort !== undefined) {
			const validSort = typeof provider.sort === 'string'
				? ['price', 'throughput', 'latency'].includes(provider.sort)
				: provider.sort !== null && typeof provider.sort === 'object' && !Array.isArray(provider.sort)
					&& Object.keys(provider.sort as Record<string, unknown>).every((key) => key === 'by' || key === 'partition')
					&& ['price', 'throughput', 'latency'].includes(String((provider.sort as Record<string, unknown>).by))
					&& ['model', 'none'].includes(String((provider.sort as Record<string, unknown>).partition ?? 'model'));
			if (!validSort) return { ok: false, message: 'provider.sort is invalid' };
		}
		if (provider.quantizations !== undefined && (
			!Array.isArray(provider.quantizations)
			|| provider.quantizations.length === 0
			|| provider.quantizations.length > 32
			|| provider.quantizations.some((item) => typeof item !== 'string' || !item.trim() || item.length > 32)
		)) {
			return { ok: false, message: 'provider.quantizations must contain 1-32 names' };
		}
		if (provider.max_price !== undefined) {
			if (!provider.max_price || typeof provider.max_price !== 'object' || Array.isArray(provider.max_price)) {
				return { ok: false, message: 'provider.max_price must be an object' };
			}
			const maxPrice = provider.max_price as Record<string, unknown>;
			if (Object.keys(maxPrice).some((key) => !['prompt', 'completion', 'request', 'image'].includes(key))) {
				return { ok: false, message: 'provider.max_price contains an unsupported field' };
			}
			if (Object.values(maxPrice).some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
				return { ok: false, message: 'provider.max_price values must be non-negative numbers' };
			}
		}
	}
	const error = walkJson(config, 0, { nodes: 0 });
	if (error) return { ok: false, message: error };
	const configJson = JSON.stringify(config);
	if (new TextEncoder().encode(configJson).byteLength > REQUEST_PRESET_MAX_CONFIG_BYTES) {
		return { ok: false, message: 'Preset config exceeds 64 KiB' };
	}
	return { ok: true, value: config, configJson };
}

function textContent(value: unknown): string | null {
	if (typeof value === 'string') return value;
	if (!Array.isArray(value)) return null;
	const parts = value.flatMap((part) => {
		if (!part || typeof part !== 'object') return [];
		const record = part as Record<string, unknown>;
		return (record.type === 'text' || record.type === 'input_text') && typeof record.text === 'string'
			? [record.text]
			: [];
	});
	return parts.length > 0 ? parts.join('\n') : null;
}

export function extractPresetSystemPrompt(body: Record<string, unknown>, protocol: RequestPresetProtocol): string | null {
	let prompt: string | null = null;
	if (protocol === 'chat' && Array.isArray(body.messages)) {
		const parts = body.messages.flatMap((message) => {
			if (!message || typeof message !== 'object') return [];
			const record = message as Record<string, unknown>;
			if (record.role !== 'system' && record.role !== 'developer') return [];
			const content = textContent(record.content);
			return content ? [content] : [];
		});
		prompt = parts.length > 0 ? parts.join('\n\n') : null;
	} else if (protocol === 'messages') {
		prompt = textContent(body.system);
	} else if (protocol === 'responses') {
		prompt = typeof body.instructions === 'string' ? body.instructions : null;
	}
	if (prompt == null || prompt.length === 0) return null;
	if (new TextEncoder().encode(prompt).byteLength > REQUEST_PRESET_MAX_SYSTEM_PROMPT_BYTES) {
		throw new Error('Preset system prompt exceeds 32 KiB');
	}
	return prompt;
}

export function captureRequestPresetConfig(body: Record<string, unknown>, protocol: RequestPresetProtocol): PresetConfigValidationResult & { systemPrompt?: string | null } {
	const config: Record<string, unknown> = {};
	for (const key of ALLOWED_CONFIG_FIELDS) {
		if (Object.prototype.hasOwnProperty.call(body, key)) config[key] = body[key];
	}
	const validated = validateRequestPresetConfig(config);
	if (!validated.ok) return validated;
	try {
		return { ...validated, systemPrompt: extractPresetSystemPrompt(body, protocol) };
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : 'Invalid preset system prompt' };
	}
}

function storedPresetConfig(configJson: string): Record<string, unknown> {
	if (new TextEncoder().encode(configJson).byteLength > REQUEST_PRESET_MAX_CONFIG_BYTES) {
		throw new TypeError('Stored preset config exceeds 64 KiB');
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(configJson);
	} catch {
		throw new TypeError('Stored preset config is invalid');
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new TypeError('Stored preset config is invalid');
	}
	const validated = validateRequestPresetConfig(parsed);
	if (!validated.ok) throw new TypeError(validated.message);
	return validated.value;
}

export function publicRequestPresetVersion(row: RequestPresetVersionRow) {
	return {
		config: storedPresetConfig(row.config_json),
		created_at: row.created_at,
		creator_id: row.created_by_user_id,
		id: row.id,
		preset_id: row.preset_id,
		system_prompt: row.system_prompt,
		updated_at: row.created_at,
		version: row.version,
	};
}

export function publicRequestPreset(row: RequestPresetWithVersionRow, includeVersion = false) {
	const summary = {
		created_at: row.created_at,
		creator_user_id: row.owner_user_id,
		description: row.description,
		designated_version_id: row.version_id,
		id: row.id,
		name: row.name,
		slug: row.slug,
		status: row.status,
		status_updated_at: row.status === 'archived' ? row.updated_at : null,
		updated_at: row.updated_at,
		workspace_id: row.workspace_id,
	};
	if (!includeVersion) return summary;
	return {
		...summary,
		designated_version: publicRequestPresetVersion({
			id: row.version_id,
			preset_id: row.id,
			version: row.designated_version,
			system_prompt: row.version_system_prompt,
			config_json: row.version_config_json,
			created_by_user_id: row.version_created_by_user_id,
			created_at: row.version_created_at,
		}),
	};
}

function toolIdentity(tool: unknown): string | null {
	if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return null;
	const record = tool as Record<string, unknown>;
	const type = typeof record.type === 'string' ? record.type : '';
	if (type === 'function' && record.function && typeof record.function === 'object') {
		const name = (record.function as Record<string, unknown>).name;
		return typeof name === 'string' && name ? `function:${name}` : null;
	}
	if (typeof record.name === 'string' && record.name) return `${type || 'tool'}:${record.name}`;
	if ((type === 'advisor' || type === 'subagent') && record.parameters && typeof record.parameters === 'object') {
		const name = (record.parameters as Record<string, unknown>).name;
		return typeof name === 'string' && name ? `${type}:${name}` : null;
	}
	return type ? `singleton:${type}` : null;
}

export function mergeRequestPresetTools(presetTools: unknown, requestTools: unknown): unknown {
	if (!Array.isArray(presetTools)) return requestTools;
	if (!Array.isArray(requestTools)) return requestTools === undefined ? presetTools : requestTools;
	const overrides = new Map<string, unknown>();
	const anonymous: unknown[] = [];
	for (const tool of requestTools) {
		const identity = toolIdentity(tool);
		if (identity) overrides.set(identity, tool);
		else anonymous.push(tool);
	}
	const merged = presetTools.map((tool) => {
		const identity = toolIdentity(tool);
		if (!identity || !overrides.has(identity)) return tool;
		const replacement = overrides.get(identity);
		overrides.delete(identity);
		return replacement;
	});
	return [...merged, ...overrides.values(), ...anonymous];
}

function parsePresetReference(body: Record<string, unknown>):
	| { ok: true; slug: string | null; modelOverride: string | null }
	| { ok: false; message: string } {
	let explicitSlug: string | null = null;
	if (body.preset !== undefined) {
		explicitSlug = normalizeRequestPresetSlug(body.preset);
		if (!explicitSlug) return { ok: false, message: 'Invalid preset slug' };
	}
	let modelSlug: string | null = null;
	let modelOverride: string | null = null;
	if (typeof body.model === 'string') {
		const model = body.model.trim();
		if (model.startsWith('@preset/')) {
			modelSlug = normalizeRequestPresetSlug(model);
			if (!modelSlug) return { ok: false, message: 'Invalid preset model reference' };
		} else {
			const marker = model.lastIndexOf('@preset/');
			if (marker > 0) {
				modelOverride = model.slice(0, marker).trim();
				modelSlug = normalizeRequestPresetSlug(model.slice(marker));
				if (!modelOverride || !modelSlug) return { ok: false, message: 'Invalid preset model reference' };
			}
		}
	}
	if (explicitSlug && modelSlug && explicitSlug !== modelSlug) {
		return { ok: false, message: 'preset and model reference different slugs' };
	}
	return { ok: true, slug: explicitSlug ?? modelSlug, modelOverride };
}

export async function resolveRequestPreset(
	repositories: GatewayRepositories,
	workspaceId: string,
	userId: string,
	body: Record<string, unknown>,
	protocol: RequestPresetProtocol,
): Promise<PresetResolutionResult> {
	const reference = parsePresetReference(body);
	if (!reference.ok) return { ok: false, status: 400, code: 'invalid_preset_reference', message: reference.message };
	if (!reference.slug) return { ok: true, body, preset: null };
	const preset = await repositories.requestPresets.getAccessibleBySlug(reference.slug, workspaceId, userId);
	if (!preset) return { ok: false, status: 404, code: 'preset_not_found', message: 'Preset not found or not accessible' };
	let config: Record<string, unknown>;
	try {
		config = storedPresetConfig(preset.version_config_json);
	} catch {
		return { ok: false, status: 409, code: 'preset_invalid', message: 'Preset designated version is invalid' };
	}
	const requestBody = { ...body };
	delete requestBody.preset;
	if (reference.modelOverride) requestBody.model = reference.modelOverride;
	else if (typeof requestBody.model === 'string' && requestBody.model.startsWith('@preset/')) delete requestBody.model;
	const merged: Record<string, unknown> = { ...config, ...requestBody };
	if (config.tools !== undefined || requestBody.tools !== undefined) {
		merged.tools = mergeRequestPresetTools(config.tools, requestBody.tools);
	}
	if (preset.version_system_prompt) {
		if (protocol === 'chat') {
			const messages = Array.isArray(merged.messages) ? merged.messages : [];
			const hasExplicit = messages.some((message) => message && typeof message === 'object' && ['system', 'developer'].includes(String((message as Record<string, unknown>).role)));
			if (!hasExplicit) merged.messages = [{ role: 'system', content: preset.version_system_prompt }, ...messages];
		} else if (protocol === 'messages' && merged.system === undefined) {
			merged.system = preset.version_system_prompt;
		} else if (protocol === 'responses' && merged.instructions === undefined) {
			merged.instructions = preset.version_system_prompt;
		}
	}
	return { ok: true, body: merged, preset };
}

export async function saveRequestPresetVersion(
	repositories: GatewayRepositories,
	params: {
		workspaceId: string;
		ownerUserId: string;
		slug: unknown;
		name?: unknown;
		description?: unknown;
		visibility?: unknown;
		systemPrompt: string | null;
		config: unknown;
	},
): Promise<{ ok: true; preset: RequestPresetWithVersionRow } | { ok: false; status: 400 | 403 | 409; message: string }> {
	const slug = normalizeRequestPresetSlug(params.slug);
	if (!slug) return { ok: false, status: 400, message: 'Slug must contain 1-64 lowercase letters, numbers, underscores, or hyphens' };
	const validated = validateRequestPresetConfig(params.config);
	if (!validated.ok) return { ok: false, status: 400, message: validated.message };
	if (params.systemPrompt && new TextEncoder().encode(params.systemPrompt).byteLength > REQUEST_PRESET_MAX_SYSTEM_PROMPT_BYTES) {
		return { ok: false, status: 400, message: 'Preset system prompt exceeds 32 KiB' };
	}
	const visibility: RequestPresetVisibility = params.visibility === 'public' ? 'public' : 'private';
	if (params.visibility !== undefined && params.visibility !== 'private' && params.visibility !== 'public') {
		return { ok: false, status: 400, message: 'Visibility must be private or public' };
	}
	const existing = await repositories.requestPresets.getBySlug(slug, params.workspaceId);
	const nowIso = new Date().toISOString();
	if (existing) {
		if (existing.owner_user_id !== params.ownerUserId) return { ok: false, status: 403, message: 'Preset slug is owned by another user' };
		if (existing.status !== 'active') return { ok: false, status: 409, message: 'Archived preset cannot receive new versions' };
		const preset = await repositories.requestPresets.addVersion({
			presetId: existing.id, versionId: crypto.randomUUID(), systemPrompt: params.systemPrompt,
			configJson: validated.configJson, createdByUserId: params.ownerUserId, nowIso,
		});
		const metadata: Parameters<typeof repositories.requestPresets.updateMetadata>[1] = { nowIso };
		if (typeof params.name === 'string' && params.name.trim()) metadata.name = params.name.trim().slice(0, 128);
		if (params.description === null || typeof params.description === 'string') metadata.description = typeof params.description === 'string' ? params.description.trim().slice(0, 1024) || null : null;
		if (params.visibility !== undefined) metadata.visibility = visibility;
		if (Object.keys(metadata).length > 1) await repositories.requestPresets.updateMetadata(existing.id, metadata);
		return { ok: true, preset: (await repositories.requestPresets.getById(existing.id)) ?? preset };
	}
	const preset = await repositories.requestPresets.createWithVersion({
		id: crypto.randomUUID(), versionId: crypto.randomUUID(), workspaceId: params.workspaceId,
		ownerUserId: params.ownerUserId,
		slug, name: typeof params.name === 'string' && params.name.trim() ? params.name.trim().slice(0, 128) : slug,
		description: typeof params.description === 'string' ? params.description.trim().slice(0, 1024) || null : null,
		visibility, systemPrompt: params.systemPrompt, configJson: validated.configJson,
		createdByUserId: params.ownerUserId, nowIso,
	});
	return { ok: true, preset };
}
