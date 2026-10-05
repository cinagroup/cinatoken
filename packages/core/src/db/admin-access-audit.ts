import type { AdminApiKeyStatus } from './admin-access-types';

export type AdminApiKeyAuditAction = 'created' | 'updated' | 'revealed' | 'rotated' | 'revoked' | 'activated';

export interface AdminApiKeyAuditContext {
	auditId: string;
	actorId: string;
	nowIso: string;
}

export interface AdminApiKeyAuditCursor {
	createdAt: string;
	id: string;
}

export interface AdminApiKeyAuditRow extends AdminApiKeyAuditCursor {
	keyId: string;
	action: AdminApiKeyAuditAction;
	changeMask: number;
	actorKind: 'console';
	actorId: string;
	beforePermissions: string[] | null;
	afterPermissions: string[] | null;
	beforeStatus: AdminApiKeyStatus | null;
	afterStatus: AdminApiKeyStatus | null;
}

export const ADMIN_API_KEY_AUDIT_CHANGE = {
	name: 1,
	description: 2,
	permissions: 4,
	secret: 8,
	status: 16,
} as const;

const allowedPermissions = new Set([
	'users.read', 'users.write', 'user_keys.read', 'user_keys.write',
	'providers.read', 'providers.write', 'providers.secrets.read',
	'models.read', 'models.write', 'presets.read', 'presets.write',
	'guardrails.read', 'guardrails.write', 'routes.read', 'routes.write',
	'config.read', 'config.write', 'config.secrets.read',
	'analytics.read', 'logs.read', 'playground.execute', '*',
]);

/** Stored audit permissions are a known finite vocabulary, never caller-supplied text. */
export function safeAuditPermissionsJson(value: string | null): string | null {
	if (value === null || value.length > 4096) return null;
	try {
		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string' && allowedPermissions.has(entry))) {
			return null;
		}
		const permissions = [...new Set(parsed as string[])].sort();
		return JSON.stringify(permissions.includes('*') ? ['*'] : permissions);
	} catch {
		return null;
	}
}

export function auditActionForPatch(patch: {
	secretKey?: string;
	status?: AdminApiKeyStatus;
}): AdminApiKeyAuditAction {
	if (patch.secretKey !== undefined) return 'rotated';
	if (patch.status === 'revoked') return 'revoked';
	if (patch.status === 'active') return 'activated';
	return 'updated';
}

export function auditChangeMask(patch: {
	name?: string;
	description?: string | null;
	permissionsJson?: string;
	secretKey?: string;
	status?: AdminApiKeyStatus;
}): number {
	return (patch.name === undefined ? 0 : ADMIN_API_KEY_AUDIT_CHANGE.name)
		| (patch.description === undefined ? 0 : ADMIN_API_KEY_AUDIT_CHANGE.description)
		| (patch.permissionsJson === undefined ? 0 : ADMIN_API_KEY_AUDIT_CHANGE.permissions)
		| (patch.secretKey === undefined ? 0 : ADMIN_API_KEY_AUDIT_CHANGE.secret)
		| (patch.status === undefined ? 0 : ADMIN_API_KEY_AUDIT_CHANGE.status);
}

const consoleAuditActorPattern = /^console:[^\u0000-\u001f\u007f]{1,264}$/u;

function validConsoleAuditActor(value: unknown): value is string {
	return typeof value === 'string' && consoleAuditActorPattern.test(value);
}

export function validateAdminApiKeyAuditContext(context: AdminApiKeyAuditContext): void {
	if (!context || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(context.auditId)
		|| !validConsoleAuditActor(context.actorId)
		|| !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(context.nowIso)
		|| !Number.isFinite(Date.parse(context.nowIso)) || new Date(context.nowIso).toISOString() !== context.nowIso) {
		throw new TypeError('Invalid Admin API key audit context');
	}
}

export type AdminApiKeyAuditSqlRow = {
	id: string;
	key_id: string;
	action: AdminApiKeyAuditAction;
	change_mask: number;
	actor_kind: 'console';
	actor_id: string;
	before_permissions_json: string | null;
	after_permissions_json: string | null;
	before_status: AdminApiKeyStatus | null;
	after_status: AdminApiKeyStatus | null;
	created_at: string;
};

export function mapAdminApiKeyAuditRow(row: AdminApiKeyAuditSqlRow): AdminApiKeyAuditRow {
	if (row.actor_kind !== 'console' || !validConsoleAuditActor(row.actor_id)) {
		throw new TypeError('Invalid Admin API key audit actor');
	}
	const before = safeAuditPermissionsJson(row.before_permissions_json);
	const after = safeAuditPermissionsJson(row.after_permissions_json);
	return {
		id: row.id,
		keyId: row.key_id,
		action: row.action,
		changeMask: Number(row.change_mask),
		actorKind: row.actor_kind,
		actorId: row.actor_id,
		beforePermissions: before === null ? null : JSON.parse(before),
		afterPermissions: after === null ? null : JSON.parse(after),
		beforeStatus: row.before_status,
		afterStatus: row.after_status,
		createdAt: row.created_at,
	};
}
