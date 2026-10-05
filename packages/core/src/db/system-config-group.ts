import type { ConfigGroupApplyInput, ConfigGroupAuditRow, ConfigGroupAuditPageOptions, ConfigRevisionVector, ConfigSnapshot, ToolConfigFamily, ToolConfigProvider } from './system-config-group-types';

export const TOOL_CONFIG_FAMILY_KEYS = {
	'web-search': ['BILLING_CURRENCY', 'WEB_SEARCH_ACTIVE', 'WEB_SEARCH_API_KEY', 'WEB_SEARCH_CATALOG', 'WEB_SEARCH_COST', 'WEB_SEARCH_PROVIDER'],
	'web-fetch': ['BILLING_CURRENCY', 'WEB_FETCH_ACTIVE', 'WEB_FETCH_API_KEY', 'WEB_FETCH_CATALOG', 'WEB_FETCH_COST', 'WEB_FETCH_PROVIDER'],
	'web-deep-search': ['BILLING_CURRENCY', 'WEB_DEEP_SEARCH_ACTIVE', 'WEB_DEEP_SEARCH_CATALOG'],
	'ai-detection': ['AI_DETECTION_ACTIVE', 'AI_DETECTION_CATALOG', 'BILLING_CURRENCY'],
} as const;
export const TOOL_CONFIG_FAMILY_PROVIDERS = {
	'web-search': ['bocha', 'tavily', 'cleversee', 'tencent_wsa'],
	'web-fetch': ['firecrawl', 'tavily', 'jina'],
	'web-deep-search': ['firecrawl', 'jina'],
	'ai-detection': ['tencent_tms'],
} as const;
const familyFields = new Set(['catalog', 'active', 'legacy_migration']);
const fields = new Set(['catalog', 'active', 'legacy_migration', 'metered', 'standard', 'charged', 'billingUnitChars', 'region', 'bizType', 'apiKey', 'secretId', 'secretKey', 'email']);
const credentialFields = new Set(['apiKey', 'secretId', 'secretKey', 'email']);
const actions = new Set(['save', 'save_activate', 'activate', 'legacy_save', 'reveal']);
const operations = new Set(['keep', 'set', 'clear', 'reveal']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const controls = /[\u0000-\u001f\u007f]/u;
const invalid = () => new TypeError('Invalid config group contract');
const bounded = (value: unknown, max: number): value is string => typeof value === 'string' && [...value].length > 0 && [...value].length <= max && !controls.test(value);
export function assertToolConfigFamily(value: unknown): asserts value is ToolConfigFamily {
	if (typeof value !== 'string' || !Object.hasOwn(TOOL_CONFIG_FAMILY_KEYS, value)) throw invalid();
}
export function validateConfigSnapshotKeys(keys: readonly string[]): string[] {
	if (!Array.isArray(keys) || keys.length < 1 || keys.length > 32 || keys.some(key => !bounded(key, 255)) || new Set(keys).size !== keys.length) throw invalid();
	return [...keys].sort();
}
function revisionValid(value: unknown): boolean { return value === null || value === 'legacy' || typeof value === 'string' && uuid.test(value); }
export function validateConfigRevisionVector(family: ToolConfigFamily, vector: ConfigRevisionVector): void {
	assertToolConfigFamily(family);
	const keys: readonly string[] = TOOL_CONFIG_FAMILY_KEYS[family];
	if (!Array.isArray(vector) || vector.length !== keys.length || vector.some((row, index) => !row || row.key !== keys[index] || !revisionValid(row.revision))) throw invalid();
}
export function completeConfigSnapshots(keys: readonly string[], rows: readonly ConfigSnapshot[]): ConfigSnapshot[] {
	const sorted = validateConfigSnapshotKeys(keys);
	if (!Array.isArray(rows) || rows.some(row => !sorted.includes(row.key) || !revisionValid(row.revision) || row.revision === null || row.value !== null && typeof row.value !== 'string') || new Set(rows.map(row => row.key)).size !== rows.length) throw invalid();
	return sorted.map(key => { const row = rows.find(row => row.key === key); return { key, value: row?.value ?? null, revision: row?.revision ?? null }; });
}
/** Pure resolver input for a family or a shared all-family pricing snapshot. */
export function toolConfigValuesFromSnapshots(family: ToolConfigFamily, snapshots: readonly ConfigSnapshot[]): Record<string, string | null> {
	assertToolConfigFamily(family);
	const keys: readonly string[] = TOOL_CONFIG_FAMILY_KEYS[family];
	if (!Array.isArray(snapshots) || new Set(snapshots.map(row => row.key)).size !== snapshots.length) throw invalid();
	const result: Record<string, string | null> = {};
	for (const key of keys) {
		const row = snapshots.find(row => row.key === key);
		if (!row || !revisionValid(row.revision) || row.value !== null && typeof row.value !== 'string' || row.revision === null && row.value !== null) throw invalid();
		result[key] = row.value;
	}
	return result;
}
export function configRevisionVector(rows: readonly ConfigSnapshot[]): ConfigRevisionVector {
	return rows.map(({ key, revision }) => ({ key, revision }));
}
export function configReadSetMatches(expected: ConfigRevisionVector, actual: readonly ConfigSnapshot[]): boolean {
	return expected.length === actual.length && expected.every((row, index) => row.key === actual[index]?.key && row.revision === actual[index]?.revision);
}
function providerValid(family: ToolConfigFamily, provider: unknown): provider is ToolConfigProvider {
	return typeof provider === 'string' && (TOOL_CONFIG_FAMILY_PROVIDERS[family] as readonly string[]).includes(provider);
}
export function validateConfigGroupInput(input: ConfigGroupApplyInput): void {
	if (!input) throw invalid();
	assertToolConfigFamily(input.family); validateConfigRevisionVector(input.family, input.readSet);
	const audit = input.safeAudit;
	if (!audit || typeof audit.auditId !== 'string' || !uuid.test(audit.auditId) || !actions.has(audit.action)
		|| !['console', 'admin_key'].includes(audit.actorKind)
		|| !bounded(audit.actorId, audit.actorKind === 'console' ? 617 : 600) || audit.actorKind === 'console' && (!audit.actorId.startsWith('console:') || audit.actorId.length <= 8)
		|| !bounded(audit.reason, 600) || !audit.reason.trim()
		|| !['admin_api', 'legacy_admin'].includes(audit.source)
		|| !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(audit.nowIso) || !Number.isFinite(Date.parse(audit.nowIso)) || new Date(audit.nowIso).toISOString() !== audit.nowIso
		|| (audit.provider === null ? audit.action !== 'legacy_save' : !providerValid(input.family, audit.provider))
		|| audit.activeBefore !== null && !providerValid(input.family, audit.activeBefore) || audit.activeAfter !== null && !providerValid(input.family, audit.activeAfter)) throw invalid();
	if (!Array.isArray(audit.changedFields) || audit.changedFields.length > 59
		|| audit.changedFields.some(row => !row || !fields.has(row.field) || (row.provider === null ? !familyFields.has(row.field) : !providerValid(input.family, row.provider)))
		|| new Set(audit.changedFields.map(row => `${row.provider}:${row.field}`)).size !== audit.changedFields.length) throw invalid();
	if (!Array.isArray(audit.credentials) || audit.credentials.length > TOOL_CONFIG_FAMILY_PROVIDERS[input.family].length * 4
		|| audit.credentials.some(row => !row || !providerValid(input.family, row.provider) || !credentialFields.has(row.field) || !operations.has(row.operation)
			|| typeof row.configuredBefore !== 'boolean' || typeof row.configuredAfter !== 'boolean')
		|| new Set(audit.credentials.map(row => `${row.provider}:${row.field}`)).size !== audit.credentials.length) throw invalid();
	const writableKeys = TOOL_CONFIG_FAMILY_KEYS[input.family].filter(key => key.endsWith('_CATALOG') || key.endsWith('_ACTIVE')) as readonly string[];
	if (!Array.isArray(input.writes) || input.writes.length > 2 || input.writes.some(row => !row || !writableKeys.includes(row.key) || typeof row.value !== 'string' || new TextEncoder().encode(row.value).length > 65535)
		|| new Set(input.writes.map(row => row.key)).size !== input.writes.length || audit.action === 'reveal' && input.writes.length !== 0) throw invalid();
	if (audit.action === 'reveal' ? audit.credentials.length !== 1 || audit.credentials[0]?.operation !== 'reveal' : audit.credentials.some(row => row.operation === 'reveal')) throw invalid();
}
export function prepareConfigGroup(input: ConfigGroupApplyInput) {
	validateConfigGroupInput(input);
	const writes = [...input.writes].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).map(row => ({ ...row, revision: crypto.randomUUID() }));
	const after = input.readSet.map(row => ({ ...row, revision: writes.find(write => write.key === row.key)?.revision ?? row.revision }));
	return { writes, after };
}
export const CONFIG_GROUP_AUDIT_COLUMNS = `id, family, provider, action, actor_kind, actor_id, reason, changed_fields_json,
	active_before, active_after, credentials_json, revision_before_json, revision_after_json, source, created_at`;
export function configGroupAuditValues(input: ConfigGroupApplyInput, after: ConfigRevisionVector): (string | null)[] {
	const audit = input.safeAudit;
	return [audit.auditId, input.family, audit.provider, audit.action, audit.actorKind, audit.actorId, audit.reason,
		JSON.stringify(audit.changedFields.map(({ provider, field }) => ({ provider, field }))), audit.activeBefore, audit.activeAfter,
		JSON.stringify(audit.credentials.map(({ provider, field, operation, configuredBefore, configuredAfter }) => ({ provider, field, operation, configuredBefore, configuredAfter }))),
		JSON.stringify(input.readSet.map(({ key, revision }) => ({ key, revision }))), JSON.stringify(after.map(({ key, revision }) => ({ key, revision }))),
		audit.source, audit.nowIso.replace(/Z$/u, '000Z')];
}
export function validateConfigGroupAuditPage(family: ToolConfigFamily, options: ConfigGroupAuditPageOptions): void {
	assertToolConfigFamily(family);
	if (!options || !Number.isInteger(options.limit) || options.limit < 1 || options.limit > 101
		|| options.before && (typeof options.before.id !== 'string' || !uuid.test(options.before.id) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(options.before.createdAt) || !Number.isFinite(Date.parse(options.before.createdAt)) || new Date(options.before.createdAt).toISOString() !== options.before.createdAt.slice(0, 23) + 'Z')) throw invalid();
}
export function mapConfigGroupAuditRow(row: Record<string, unknown>): ConfigGroupAuditRow {
	try {
		const json = (value: unknown): unknown => {
			if (typeof value !== 'string' || new TextEncoder().encode(value).length > 16384) throw invalid();
			return JSON.parse(value);
		};
		const input = { family: row.family, readSet: json(row.revision_before_json), writes: [], safeAudit: {
			auditId: row.id, actorKind: row.actor_kind, actorId: row.actor_id, reason: row.reason, action: row.action, provider: row.provider,
			changedFields: json(row.changed_fields_json), activeBefore: row.active_before, activeAfter: row.active_after,
			credentials: json(row.credentials_json), source: row.source, nowIso: String(row.created_at).replace(/(\.\d{3})\d{3}Z$/u, '$1Z'),
		} } as ConfigGroupApplyInput;
		validateConfigGroupInput(input);
		const after = json(row.revision_after_json) as ConfigRevisionVector; validateConfigRevisionVector(input.family, after);
		if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(String(row.created_at))) throw invalid();
		const { auditId, nowIso: _nowIso, ...audit } = input.safeAudit;
		return { id: auditId, ...audit,
			changedFields: audit.changedFields.map(({ provider, field }) => ({ provider, field })),
			credentials: audit.credentials.map(({ provider, field, operation, configuredBefore, configuredAfter }) => ({ provider, field, operation, configuredBefore, configuredAfter })),
			family: input.family, revisionBefore: input.readSet.map(({ key, revision }) => ({ key, revision })), revisionAfter: after.map(({ key, revision }) => ({ key, revision })), createdAt: String(row.created_at) };
	} catch { throw invalid(); }
}
