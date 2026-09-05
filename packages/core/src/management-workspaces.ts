import type { ManagementApiKeyAccount } from './db/management-api-keys-types';
import type { WorkspaceRole, WorkspaceScopeType } from './workspaces';

export const MANAGEMENT_WORKSPACE_PROVIDER_SORTS = [
	'price',
	'throughput',
	'latency',
	'exacto',
] as const;

export type ManagementWorkspaceProviderSort =
	(typeof MANAGEMENT_WORKSPACE_PROVIDER_SORTS)[number];

export type ManagementWorkspaceSettings = {
	defaultImageModel: string | null;
	defaultProviderSort: ManagementWorkspaceProviderSort | null;
	defaultTextModel: string | null;
	ioLoggingApiKeyIds: number[] | null;
	ioLoggingSamplingRate: number;
	isDataDiscountLoggingEnabled: false;
	isObservabilityBroadcastEnabled: false;
	isObservabilityIoLoggingEnabled: false;
};

export type ManagementWorkspaceRow = {
	id: string;
	scope_type: WorkspaceScopeType;
	organization_id: string | null;
	personal_owner_user_id: string | null;
	name: string;
	slug: string;
	description: string | null;
	is_default: boolean;
	status: 'active' | 'archived';
	created_by: string | null;
	created_by_user_id: string | null;
	created_at: string;
	updated_at: string;
	settings: ManagementWorkspaceSettings;
};

export type ManagementWorkspaceMemberRow = {
	id: string;
	workspace_id: string;
	user_id: string;
	role: WorkspaceRole;
	created_at: string;
};

export type ManagementWorkspaceListPage = {
	data: ManagementWorkspaceRow[];
	totalCount: number;
};

export type ManagementWorkspaceMemberListPage = {
	data: ManagementWorkspaceMemberRow[];
	totalCount: number;
};

export type ManagementWorkspaceCreate = {
	name: string;
	slug: string;
	description: string | null;
	settings: ManagementWorkspaceSettings;
};

export type ManagementWorkspacePatch = {
	name?: string;
	slug?: string;
	description?: string | null;
	settings?: Partial<ManagementWorkspaceSettings>;
};

export type ManagementWorkspaceMutationPrincipal = {
	keyId: string;
	createdByUserId: string | null;
	account: ManagementApiKeyAccount;
};

export type ManagementWorkspaceDeleteResult =
	| 'deleted'
	| 'not_found'
	| 'active_keys'
	| 'account_default_anchor'
	| 'confirmation_required';

export type ManagementWorkspaceMemberMutationResult =
	| { ok: true; data: ManagementWorkspaceMemberRow[]; changedCount: number }
	| { ok: false; reason: 'not_found' | 'personal_workspace' | 'default_workspace' | 'unknown_members' | 'active_keys' };

const MANAGEMENT_WORKSPACE_FIELDS = new Set([
	'default_image_model',
	'default_provider_sort',
	'default_text_model',
	'description',
	'io_logging_api_key_ids',
	'io_logging_sampling_rate',
	'is_data_discount_logging_enabled',
	'is_observability_broadcast_enabled',
	'is_observability_io_logging_enabled',
	'name',
	'slug',
]);

const PROVIDER_SORTS = new Set<string>(MANAGEMENT_WORKSPACE_PROVIDER_SORTS);
const WORKSPACE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MODEL_ID_MAX_LENGTH = 240;
const ORGANIZATION_ROLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

export const DEFAULT_MANAGEMENT_WORKSPACE_SETTINGS: Readonly<ManagementWorkspaceSettings> = {
	defaultImageModel: null,
	defaultProviderSort: null,
	defaultTextModel: null,
	ioLoggingApiKeyIds: null,
	ioLoggingSamplingRate: 1,
	isDataDiscountLoggingEnabled: false,
	isObservabilityBroadcastEnabled: false,
	isObservabilityIoLoggingEnabled: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeName(value: unknown): string {
	if (typeof value !== 'string') throw new TypeError('name is required');
	const normalized = value.trim();
	if (!normalized || normalized.length > 100) {
		throw new TypeError('name must contain between 1 and 100 characters');
	}
	return normalized;
}

function normalizeSlug(value: unknown): string {
	if (typeof value !== 'string') throw new TypeError('slug is required');
	const normalized = value.trim();
	if (!normalized || normalized.length > 50 || !WORKSPACE_SLUG.test(normalized)) {
		throw new TypeError('slug must use lowercase alphanumeric segments separated by single hyphens');
	}
	return normalized;
}

function normalizeDescription(value: unknown): string | null {
	if (value === null) return null;
	if (typeof value !== 'string') throw new TypeError('description must be a string or null');
	const normalized = value.trim();
	if (normalized.length > 500) throw new TypeError('description must be at most 500 characters');
	return normalized || null;
}

function normalizeModel(value: unknown, field: string): string | null {
	if (value === null) return null;
	if (typeof value !== 'string') throw new TypeError(`${field} must be a model ID or null`);
	const normalized = value.trim();
	if (!normalized || normalized.length > MODEL_ID_MAX_LENGTH) {
		throw new TypeError(`${field} must be a non-empty model ID of at most ${MODEL_ID_MAX_LENGTH} characters`);
	}
	return normalized;
}

function normalizeProviderSort(value: unknown): ManagementWorkspaceProviderSort | null {
	if (value === null) return null;
	if (typeof value !== 'string' || !PROVIDER_SORTS.has(value)) {
		throw new TypeError('default_provider_sort must be one of: price, throughput, latency, exacto, or null');
	}
	return value as ManagementWorkspaceProviderSort;
}

function normalizeSamplingRate(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.0001 || value > 1) {
		throw new TypeError('io_logging_sampling_rate must be between 0.0001 and 1');
	}
	return value;
}

function rejectUnsupportedLoggingSetting(
	value: unknown,
	field: 'is_data_discount_logging_enabled' | 'is_observability_broadcast_enabled' | 'is_observability_io_logging_enabled',
): false {
	if (value !== false) {
		throw new TypeError(`${field} must remain false until the corresponding observability feature is enabled`);
	}
	return false;
}

function settingsPatch(body: Record<string, unknown>): Partial<ManagementWorkspaceSettings> {
	const patch: Partial<ManagementWorkspaceSettings> = {};
	if ('default_image_model' in body) patch.defaultImageModel = normalizeModel(body.default_image_model, 'default_image_model');
	if ('default_provider_sort' in body) patch.defaultProviderSort = normalizeProviderSort(body.default_provider_sort);
	if ('default_text_model' in body) patch.defaultTextModel = normalizeModel(body.default_text_model, 'default_text_model');
	if ('io_logging_api_key_ids' in body) {
		if (body.io_logging_api_key_ids !== null) {
			throw new TypeError('io_logging_api_key_ids must remain null until private I/O logging is enabled');
		}
		patch.ioLoggingApiKeyIds = null;
	}
	if ('io_logging_sampling_rate' in body) patch.ioLoggingSamplingRate = normalizeSamplingRate(body.io_logging_sampling_rate);
	if ('is_data_discount_logging_enabled' in body) {
		patch.isDataDiscountLoggingEnabled = rejectUnsupportedLoggingSetting(
			body.is_data_discount_logging_enabled,
			'is_data_discount_logging_enabled',
		);
	}
	if ('is_observability_broadcast_enabled' in body) {
		patch.isObservabilityBroadcastEnabled = rejectUnsupportedLoggingSetting(
			body.is_observability_broadcast_enabled,
			'is_observability_broadcast_enabled',
		);
	}
	if ('is_observability_io_logging_enabled' in body) {
		patch.isObservabilityIoLoggingEnabled = rejectUnsupportedLoggingSetting(
			body.is_observability_io_logging_enabled,
			'is_observability_io_logging_enabled',
		);
	}
	return patch;
}

function assertOnlyWorkspaceFields(body: Record<string, unknown>): void {
	const unsupported = Object.keys(body).filter((field) => !MANAGEMENT_WORKSPACE_FIELDS.has(field));
	if (unsupported.length > 0) {
		throw new TypeError(`Unsupported workspace field: ${unsupported.join(', ')}`);
	}
}

export function normalizeManagementWorkspaceCreate(value: unknown): ManagementWorkspaceCreate {
	if (!isRecord(value)) throw new TypeError('JSON body must be an object');
	assertOnlyWorkspaceFields(value);
	return {
		name: normalizeName(value.name),
		slug: normalizeSlug(value.slug),
		description: 'description' in value ? normalizeDescription(value.description) : null,
		settings: { ...DEFAULT_MANAGEMENT_WORKSPACE_SETTINGS, ...settingsPatch(value) },
	};
}

export function normalizeManagementWorkspacePatch(value: unknown): ManagementWorkspacePatch {
	if (!isRecord(value)) throw new TypeError('JSON body must be an object');
	assertOnlyWorkspaceFields(value);
	if (Object.keys(value).length === 0) throw new TypeError('At least one workspace field is required');
	const patch: ManagementWorkspacePatch = {};
	if ('name' in value) patch.name = normalizeName(value.name);
	if ('slug' in value) patch.slug = normalizeSlug(value.slug);
	if ('description' in value) patch.description = normalizeDescription(value.description);
	const settings = settingsPatch(value);
	if (Object.keys(settings).length > 0) patch.settings = settings;
	return patch;
}

export function managementWorkspaceSettingsJson(settings: ManagementWorkspaceSettings): string {
	return JSON.stringify({
		default_image_model: settings.defaultImageModel,
		default_provider_sort: settings.defaultProviderSort,
		default_text_model: settings.defaultTextModel,
		io_logging_api_key_ids: settings.ioLoggingApiKeyIds,
		io_logging_sampling_rate: settings.ioLoggingSamplingRate,
		is_data_discount_logging_enabled: settings.isDataDiscountLoggingEnabled,
		is_observability_broadcast_enabled: settings.isObservabilityBroadcastEnabled,
		is_observability_io_logging_enabled: settings.isObservabilityIoLoggingEnabled,
	});
}

/** Parse only the allow-listed settings. Corrupt or legacy values fail closed to safe defaults. */
export function parseManagementWorkspaceSettings(value: string | null): ManagementWorkspaceSettings {
	if (!value) return { ...DEFAULT_MANAGEMENT_WORKSPACE_SETTINGS };
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!isRecord(parsed)) return { ...DEFAULT_MANAGEMENT_WORKSPACE_SETTINGS };
		const settings: ManagementWorkspaceSettings = { ...DEFAULT_MANAGEMENT_WORKSPACE_SETTINGS };
		for (const field of [
			'default_image_model',
			'default_provider_sort',
			'default_text_model',
			'io_logging_api_key_ids',
			'io_logging_sampling_rate',
			'is_data_discount_logging_enabled',
			'is_observability_broadcast_enabled',
			'is_observability_io_logging_enabled',
		] as const) {
			if (!(field in parsed)) continue;
			try {
				Object.assign(settings, settingsPatch({ [field]: parsed[field] }));
			} catch {
				// One corrupt or unsupported legacy setting must not erase other safe fields.
			}
		}
		return settings;
	} catch {
		return { ...DEFAULT_MANAGEMENT_WORKSPACE_SETTINGS };
	}
}

export function mergeManagementWorkspaceSettings(
	current: ManagementWorkspaceSettings,
	patch: Partial<ManagementWorkspaceSettings> | undefined,
): ManagementWorkspaceSettings {
	return patch ? { ...current, ...patch } : current;
}

export function publicManagementWorkspace(row: ManagementWorkspaceRow) {
	return {
		created_at: row.created_at,
		created_by: row.created_by,
		default_guardrail_id: null,
		default_image_model: row.settings.defaultImageModel,
		default_provider_sort: row.settings.defaultProviderSort,
		default_text_model: row.settings.defaultTextModel,
		description: row.description,
		id: row.id,
		include_byok_in_budgets: false,
		io_logging_api_key_ids: row.settings.ioLoggingApiKeyIds,
		io_logging_sampling_rate: row.settings.ioLoggingSamplingRate,
		is_data_discount_logging_enabled: row.settings.isDataDiscountLoggingEnabled,
		is_observability_broadcast_enabled: row.settings.isObservabilityBroadcastEnabled,
		is_observability_io_logging_enabled: row.settings.isObservabilityIoLoggingEnabled,
		name: row.name,
		slug: row.slug,
		updated_at: row.updated_at,
	};
}

/** Parse the deployment's authoritative CinaAuth organization-admin mapping. */
export function parseManagementWorkspaceAdminRoles(value: string | undefined): ReadonlySet<string> {
	if (!value?.trim()) return new Set<string>();
	const roles = value.split(',').map((role) => role.trim());
	if (
		roles.length > 32
		|| roles.some((role) => !role || role.length > 128 || !ORGANIZATION_ROLE_PATTERN.test(role))
	) {
		return new Set<string>();
	}
	return new Set(roles);
}

export function managementWorkspaceRoleFromOrganizationRoles(
	rolesJson: string,
	adminRoles: ReadonlySet<string>,
): WorkspaceRole {
	if (adminRoles.size === 0) return 'member';
	try {
		const parsed = JSON.parse(rolesJson) as unknown;
		if (!Array.isArray(parsed) || parsed.length > 32) return 'member';
		return parsed.some((role) => typeof role === 'string' && adminRoles.has(role))
			? 'admin'
			: 'member';
	} catch {
		return 'member';
	}
}
