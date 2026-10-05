import { hashLookupKey } from '../lib/key-hash';
import { isSharedKeyChannelType, sharedKeyStateExpectation, type SharedKeyChannelType, type SharedKeyRow, type SharedKeyStateExpectation, type SharedKeyStatus } from './shared-keys-types';
import { sharedKeyStateValues } from './shared-key-state';

export interface AdminSharedKeyListOptions {
	page: number; pageSize: number; status?: SharedKeyStatus; channelType?: SharedKeyChannelType;
	sellerUserId?: string; search?: string;
}
export interface AdminSharedKeyGovernancePatch { sellerPriority?: number; weight?: number; status?: 'disabled' | 'paused' }
export interface AdminSharedKeyAuditContext {
	auditId: string; actorKind: 'console' | 'api_key'; actorId: string;
	source: 'admin_api' | 'legacy_admin'; reason: string; nowIso: string;
}
export interface AdminSharedKeyUpdate { id: string; expected: SharedKeyStateExpectation; patch: AdminSharedKeyGovernancePatch; audit: AdminSharedKeyAuditContext }
export interface AdminSharedKeyDelete { id: string; expected: SharedKeyStateExpectation; audit: AdminSharedKeyAuditContext }
export type AdminSharedKeyMutationOutcome = 'applied' | 'unchanged' | 'conflict' | 'not_found';
export interface AdminSharedKeyAuditCursor { createdAt: string; id: string }
export interface AdminSharedKeyAuditSnapshot { status: SharedKeyStatus; sellerPriority: number; weight: number; validated: boolean }
export interface AdminSharedKeyAuditRow extends AdminSharedKeyAuditCursor {
	keyId: string; action: 'updated' | 'disabled' | 'restored' | 'deleted'; changeMask: number;
	actorKind: 'console' | 'api_key'; actorId: string; source: 'admin_api' | 'legacy_admin'; reason: string;
	before: AdminSharedKeyAuditSnapshot; after: AdminSharedKeyAuditSnapshot | null;
	beforeRevision: string; afterRevision: string | null;
}
export interface AdminSharedKeysRepository {
	/** Governance read: storage profile only, no decryption or lazy encryption writes. */
	getAdminSharedKeyById(id: string): Promise<SharedKeyRow | null>;
	listAdminSharedKeys(options: AdminSharedKeyListOptions): Promise<{ keys: SharedKeyRow[]; total: number }>;
	updateSharedKeyAdminWithAudit(input: AdminSharedKeyUpdate): Promise<AdminSharedKeyMutationOutcome>;
	deleteSharedKeyAdminWithAudit(input: AdminSharedKeyDelete): Promise<Exclude<AdminSharedKeyMutationOutcome, 'unchanged'>>;
	listSharedKeyAdminAudit(id: string, options: { limit: number; before?: AdminSharedKeyAuditCursor }): Promise<AdminSharedKeyAuditRow[]>;
}
const statuses = ['active', 'paused', 'disabled', 'invalid', 'validating'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const controls = /[\p{Cc}]/u;
export function assertAdminSharedKeyId(id: string): void {
	if (typeof id !== 'string' || !id || id.length > 255 || /[\s/?#\\\p{Cc}]/u.test(id)) throw new TypeError('Invalid shared key id');
}
export function assertAdminSharedKeyList(options: AdminSharedKeyListOptions): void {
	if (!options || Object.keys(options).some(key => !['page', 'pageSize', 'status', 'channelType', 'sellerUserId', 'search'].includes(key)) ||
		!Number.isSafeInteger(options.page) || options.page < 1 || options.page > 1_000_000 ||
		!Number.isSafeInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 100) throw new RangeError('Invalid shared key page');
	if (options.status !== undefined && !statuses.includes(options.status) || options.channelType !== undefined && !isSharedKeyChannelType(options.channelType)) throw new TypeError('Invalid shared key filter');
	if (options.sellerUserId !== undefined) assertAdminSharedKeyId(options.sellerUserId);
	if (options.search !== undefined && (typeof options.search !== 'string' || !options.search || options.search !== options.search.trim() || options.search.length > 200 || controls.test(options.search))) throw new TypeError('Invalid shared key search');
}
export function assertAdminSharedKeyAudit(context: AdminSharedKeyAuditContext): void {
	if (!context || !uuid.test(context.auditId) || !['console', 'api_key'].includes(context.actorKind) ||
		!['admin_api', 'legacy_admin'].includes(context.source) || typeof context.actorId !== 'string' || !context.actorId || context.actorId.length > (context.actorKind === 'console' ? 617 : 600) || controls.test(context.actorId) ||
		typeof context.reason !== 'string' || !context.reason.trim() || context.reason.length > 600 || controls.test(context.reason) ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(context.nowIso) || !Number.isFinite(Date.parse(context.nowIso)) || new Date(context.nowIso).toISOString() !== context.nowIso) throw new TypeError('Invalid shared key audit context');
}
export function assertAdminSharedKeyMutation(input: AdminSharedKeyDelete | AdminSharedKeyUpdate): void {
	assertAdminSharedKeyId(input.id); sharedKeyStateValues(input.expected); assertAdminSharedKeyAudit(input.audit);
	if ('patch' in input) {
		const patch = input.patch;
		if (!patch || Array.isArray(patch) || !Object.keys(patch).length || Object.keys(patch).some(key => !['sellerPriority', 'weight', 'status'].includes(key)) ||
			patch.sellerPriority !== undefined && (!Number.isInteger(patch.sellerPriority) || patch.sellerPriority < -2147483648 || patch.sellerPriority > 2147483647) ||
			patch.weight !== undefined && (!Number.isInteger(patch.weight) || patch.weight < 1 || patch.weight > 100) ||
			patch.status !== undefined && (patch.status !== 'disabled' && patch.status !== 'paused' || patch.status === 'paused' && input.expected.status !== 'disabled')) throw new TypeError('Invalid shared key governance patch');
	}
}
/** Normalize representation while preserving the original fractional microseconds. */
export function sharedKeyAdminInstant(value: string): string {
	const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/u.test(value) ? value.replace(' ', 'T') + 'Z' : value;
	const parsed = new Date(normalized); if (!Number.isFinite(parsed.getTime()) || normalized.endsWith('Z') && normalized.slice(0, 19).replace(' ', 'T') !== parsed.toISOString().slice(0, 19)) throw new TypeError('Invalid shared key timestamp');
	const fraction = /\.(\d{1,6})(?:Z|[+-]\d{2}(?::?\d{2})?)?$/u.exec(value)?.[1] ?? '';
	return `${parsed.toISOString().slice(0, 19)}.${fraction.padEnd(6, '0')}Z`;
}
/** Public opaque precondition; key material and usage/encryption clocks are excluded. */
export async function sharedKeyAdminRevision(id: string, expected: SharedKeyStateExpectation): Promise<string> {
	assertAdminSharedKeyId(id); const values = sharedKeyStateValues(expected);
	values[4] = expected.validatedAt === null ? null : sharedKeyAdminInstant(expected.validatedAt);
	return hashLookupKey(JSON.stringify([id, ...values]));
}
export function matchesAdminSharedKeyProfile(row: SharedKeyRow, expected: SharedKeyStateExpectation): boolean {
	const actual = sharedKeyStateValues(sharedKeyStateExpectation(row)); const wanted = sharedKeyStateValues(expected);
	for (const values of [actual, wanted]) if (values[4] !== null) values[4] = sharedKeyAdminInstant(String(values[4]));
	return actual.every((value, index) => value === wanted[index]);
}
/** Known complete values are replaced before any truncation, including encrypted storage material. */
export function sharedKeyAdminAuditReason(reason: string, row: SharedKeyRow, additionalMaterial: readonly string[] = []): string {
	let safe = reason;
	for (const secret of [row.apiKey, row.keyFingerprint, ...additionalMaterial].filter(Boolean).sort((a, b) => b.length - a.length)) safe = safe.replaceAll(secret, '[redacted]');
	safe = safe.replace(/\b(?:Bearer\s+\S+|(?:sk-|sk_|rk_|pk_|AIza|ghp_|gho_|xox[baprs]-)[A-Za-z0-9_./+\-=]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/giu, '[redacted]')
		.replace(/\b(api[_ -]?key|access[_ -]?token|secret|password|credential)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/giu, '$1=[redacted]');
	return safe.trim().slice(0, 600);
}
export function assertAdminSharedKeyAuditPage(id: string, limit: number, before?: AdminSharedKeyAuditCursor): void {
	assertAdminSharedKeyId(id);
	if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Invalid shared key audit limit');
	if (before && (!uuid.test(before.id) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/u.test(before.createdAt))) throw new TypeError('Invalid shared key audit cursor');
	if (before) sharedKeyAdminInstant(before.createdAt);
}
