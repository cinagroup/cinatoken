import type { AdminApiKeyRow, AdminApiKeyStatus } from './admin-access-types';
import {
	ADMIN_API_KEY_AUDIT_CHANGE, auditActionForPatch, auditChangeMask,
	safeAuditPermissionsJson, type AdminApiKeyAuditAction, type AdminApiKeyAuditContext,
} from './admin-access-audit';

export const ADMIN_KEY_COLUMNS = `id, name, description, secret_key, key_prefix, permissions_json,
	status, last_used_at, created_at, updated_at, revoked_at`;
export const ADMIN_KEY_AUDIT_COLUMNS = `id, key_id, action, change_mask, actor_kind, actor_id,
	before_permissions_json, after_permissions_json, before_status, after_status, created_at`;
export type AdminApiKeySqlRow = {
	id: string; name: string; description: string | null; secret_key: string; key_prefix: string;
	permissions_json: string; status: AdminApiKeyStatus; last_used_at: string | null;
	created_at: string; updated_at: string; revoked_at: string | null;
};
export type AdminApiKeyPatch = {
	name?: string; description?: string | null; permissionsJson?: string; secretKey?: string;
	status?: AdminApiKeyStatus; revokedAt?: string | null;
};
export function mapAdminKeySqlRow(row: AdminApiKeySqlRow): AdminApiKeyRow {
	return { id: row.id, name: row.name, description: row.description, secretKey: row.secret_key,
		keyPrefix: row.key_prefix, permissionsJson: row.permissions_json, status: row.status,
		lastUsedAt: row.last_used_at, createdAt: row.created_at, updatedAt: row.updated_at, revokedAt: row.revoked_at };
}
export function adminKeyAuditValues(id: string, action: AdminApiKeyAuditAction, changeMask: number,
	audit: AdminApiKeyAuditContext, before: AdminApiKeySqlRow | null, patch: AdminApiKeyPatch) {
	return [audit.auditId, id, action, changeMask, 'console', audit.actorId,
		before ? safeAuditPermissionsJson(before.permissions_json) : null,
		safeAuditPermissionsJson(patch.permissionsJson ?? before?.permissions_json ?? null),
		before?.status ?? null, patch.status ?? before?.status ?? 'active', audit.nowIso];
}
export function adminKeyPatchAuditValues(id: string, audit: AdminApiKeyAuditContext,
	before: AdminApiKeySqlRow, patch: AdminApiKeyPatch) {
	return adminKeyAuditValues(id, auditActionForPatch(patch), auditChangeMask(patch), audit, before, patch);
}
export function adminKeyCreateMask(description: string | null | undefined): number {
	return ADMIN_API_KEY_AUDIT_CHANGE.name | ADMIN_API_KEY_AUDIT_CHANGE.permissions | ADMIN_API_KEY_AUDIT_CHANGE.secret
		| (description === undefined ? 0 : ADMIN_API_KEY_AUDIT_CHANGE.description);
}
/** New permissions must be entirely known. Legacy malformed values are represented as null in the audit. */
export function validateAdminKeyPermissions(value: string | undefined): void {
	if (value !== undefined && safeAuditPermissionsJson(value) === null) throw new TypeError('Invalid Admin API key permissions');
}
export function validateAdminKeyAuditLimit(limit: number): void {
	if (!Number.isInteger(limit) || limit < 1 || limit > 101) throw new RangeError('Invalid Admin API key audit page size');
}
/** Preserve all six fractional digits in a cursor rather than rounding to JS milliseconds. */
export function adminKeyAuditCursorMySqlTime(value: string): string {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:\d{3})?Z$/u.test(value) || !Number.isFinite(Date.parse(value))) {
		throw new TypeError('Invalid Admin API key audit cursor');
	}
	return value.slice(0, -1).replace('T', ' ').padEnd(26, '0');
}
