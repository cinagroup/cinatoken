import type { D1DatabaseClient } from '../../storage/database-client';
import type { AdminAccessRepository } from '../../storage/gateway-repository-interfaces';
import { hashLookupKey, matchesLookupKeyHash } from '../../lib/key-hash';
import type {
	AdminApiKeyRow,
	AdminApiKeyStatus,
	AdminSessionRow,
} from '../admin-access-types';
import {
	ADMIN_API_KEY_AUDIT_CHANGE,
	auditActionForPatch,
	auditChangeMask,
	mapAdminApiKeyAuditRow,
	safeAuditPermissionsJson,
	validateAdminApiKeyAuditContext,
	type AdminApiKeyAuditAction,
	type AdminApiKeyAuditContext,
} from '../admin-access-audit';
import { validateAdminKeyAuditLimit, validateAdminKeyPermissions } from '../admin-access-sql';

type KeySqlRow = {
	id: string;
	name: string;
	description: string | null;
	secret_key: string;
	key_prefix: string;
	permissions_json: string;
	status: AdminApiKeyStatus;
	last_used_at: string | null;
	created_at: string;
	updated_at: string;
	revoked_at: string | null;
};

type SessionSqlRow = {
	token_hash: string;
	username: string;
	created_at: string;
	expires_at: string;
};

const KEY_COLUMNS = `id, name, description, secret_key, key_prefix, permissions_json,
  status, last_used_at, created_at, updated_at, revoked_at`;
const AUDIT_COLUMNS = `id, key_id, action, change_mask, actor_kind, actor_id,
  before_permissions_json, after_permissions_json, before_status, after_status, created_at`;
const AUDIT_PERMISSION_VALUES = `'*', 'users.read', 'users.write', 'user_keys.read', 'user_keys.write',
  'providers.read', 'providers.write', 'providers.secrets.read', 'models.read', 'models.write',
  'presets.read', 'presets.write', 'guardrails.read', 'guardrails.write', 'routes.read', 'routes.write',
  'config.read', 'config.write', 'config.secrets.read', 'analytics.read', 'logs.read', 'playground.execute'`;

/** A matching audit must correspond to one target write in this same batch.
 * Integer overflow is raised inside SQLite, so a skipped target cannot commit
 * a success audit. An absent audit/target retains the existing no-op behavior. */
function targetWriteAuditGuard(raw: D1DatabaseClient['raw'], keyId: string, auditId: string) {
	return raw.prepare(`SELECT CASE WHEN EXISTS (
		SELECT 1 FROM admin_access_key_audit WHERE id = ? AND key_id = ?
	) AND changes() != 1 THEN abs(-9223372036854775808) ELSE 1 END AS ok`).bind(auditId, keyId);
}
// Verify every element before copying a legacy permissions_json value into audit.
const SAFE_PERMISSIONS_SQL = `CASE WHEN length(permissions_json) <= 4096 AND json_valid(permissions_json) THEN
  CASE WHEN json_type(permissions_json) = 'array' AND NOT EXISTS (
    SELECT 1 FROM json_each(permissions_json)
    WHERE type <> 'text' OR value NOT IN (${AUDIT_PERMISSION_VALUES})
  ) THEN CASE WHEN EXISTS (SELECT 1 FROM json_each(permissions_json) WHERE value = '*') THEN '["*"]'
    ELSE (SELECT json_group_array(value) FROM (SELECT DISTINCT value FROM json_each(permissions_json) ORDER BY value))
    END ELSE NULL END ELSE NULL END`;
type AuditSqlRow = Parameters<typeof mapAdminApiKeyAuditRow>[0];

function auditBeforeMutation(
	id: string,
	action: AdminApiKeyAuditAction,
	changeMask: number,
	audit: AdminApiKeyAuditContext,
	afterPermissionsJson: string | undefined,
	afterStatus: AdminApiKeyStatus | undefined,
	requireActive: boolean,
) {
	return {
		sql: `INSERT INTO admin_access_key_audit (${AUDIT_COLUMNS})
      SELECT ?, id, ?, ?, 'console', ?, ${SAFE_PERMISSIONS_SQL},
        CASE WHEN ? = 1 THEN ? ELSE ${SAFE_PERMISSIONS_SQL} END,
        status, CASE WHEN ? = 1 THEN ? ELSE status END, ?
      FROM admin_api_keys WHERE id = ? ${requireActive ? "AND status = 'active'" : ''}`,
		values: [
			audit.auditId, action, changeMask, audit.actorId,
			afterPermissionsJson === undefined ? 0 : 1, afterPermissionsJson ?? null,
			afterStatus === undefined ? 0 : 1, afterStatus ?? null,
			audit.nowIso, id,
		],
	};
}

function mapKey(row: KeySqlRow): AdminApiKeyRow {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		secretKey: row.secret_key,
		keyPrefix: row.key_prefix,
		permissionsJson: row.permissions_json,
		status: row.status,
		lastUsedAt: row.last_used_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		revokedAt: row.revoked_at,
	};
}

function mapSession(row: SessionSqlRow): AdminSessionRow {
	return {
		tokenHash: row.token_hash,
		username: row.username,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
	};
}

export function createD1AdminAccessRepository(db: D1DatabaseClient): AdminAccessRepository {
	const raw = db.raw;
	return {
		async listApiKeys() {
			const rows = await raw.prepare(`SELECT ${KEY_COLUMNS} FROM admin_api_keys ORDER BY created_at DESC`).all<KeySqlRow>();
			return (rows.results ?? []).map(mapKey);
		},
		async getApiKeyById(id) {
			const row = await raw.prepare(`SELECT ${KEY_COLUMNS} FROM admin_api_keys WHERE id = ?`).bind(id).first<KeySqlRow>();
			return row ? mapKey(row) : null;
		},
		async getActiveApiKeyBySecret(secretKey) {
			// 审计 M2-2：哈希优先查找；miss 回退明文（迁移窗口），命中即惰性回填。
			const hash = await hashLookupKey(secretKey);
			const byHash = await raw.prepare(`SELECT ${KEY_COLUMNS} FROM admin_api_keys WHERE secret_key_hash = ? AND status = 'active'`).bind(hash).first<KeySqlRow>();
			if (byHash && await matchesLookupKeyHash(byHash.secret_key, hash)) return mapKey(byHash);
			const row = await raw.prepare(`SELECT ${KEY_COLUMNS} FROM admin_api_keys WHERE secret_key = ? AND status = 'active'`).bind(secretKey).first<KeySqlRow>();
			if (!row) return null;
			await raw.prepare('UPDATE admin_api_keys SET secret_key_hash = ? WHERE id = ?').bind(hash, row.id).run();
			return mapKey(row);
		},
		async insertApiKey(params, audit) {
			validateAdminApiKeyAuditContext(audit);
			validateAdminKeyPermissions(params.permissionsJson);
			const secretHash = await hashLookupKey(params.secretKey);
			const results = await raw.batch([
				raw.prepare(`INSERT INTO admin_access_key_audit (${AUDIT_COLUMNS})
					VALUES (?, ?, 'created', ?, 'console', ?, NULL, ?, NULL, 'active', ?)`).bind(
					audit.auditId, params.id,
					ADMIN_API_KEY_AUDIT_CHANGE.name | ADMIN_API_KEY_AUDIT_CHANGE.permissions | ADMIN_API_KEY_AUDIT_CHANGE.secret
						| (params.description === undefined ? 0 : ADMIN_API_KEY_AUDIT_CHANGE.description),
					audit.actorId, safeAuditPermissionsJson(params.permissionsJson), audit.nowIso,
				),
				raw.prepare(`INSERT INTO admin_api_keys
			  (id, name, description, secret_key, key_prefix, permissions_json, secret_key_hash, status, created_at, updated_at)
			  SELECT ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?
			  WHERE EXISTS (SELECT 1 FROM admin_access_key_audit WHERE id = ? AND key_id = ?)`).bind(
					params.id, params.name, params.description ?? null, params.secretKey, params.keyPrefix,
					params.permissionsJson, secretHash, audit.nowIso, audit.nowIso, audit.auditId, params.id,
				),
				targetWriteAuditGuard(raw, params.id, audit.auditId),
			]);
			if (results.slice(0, 2).some((result) => !result.success || Number(result.meta.changes) !== 1)) throw new Error('Admin API key creation audit did not commit');
		},
		async updateApiKey(id, patch, audit) {
			validateAdminApiKeyAuditContext(audit);
			validateAdminKeyPermissions(patch.permissionsJson);
			const sets: string[] = [];
			const values: unknown[] = [];
			if (patch.name !== undefined) { sets.push('name = ?'); values.push(patch.name); }
			if (patch.description !== undefined) { sets.push('description = ?'); values.push(patch.description); }
			if (patch.permissionsJson !== undefined) { sets.push('permissions_json = ?'); values.push(patch.permissionsJson); }
			if (patch.secretKey !== undefined) {
				sets.push('secret_key = ?', 'secret_key_hash = ?', 'key_prefix = ?');
				values.push(
					patch.secretKey,
					await hashLookupKey(patch.secretKey),
					patch.secretKey.slice(0, 12),
				);
			}
			if (patch.status !== undefined) { sets.push('status = ?'); values.push(patch.status); }
			if (patch.revokedAt !== undefined) { sets.push('revoked_at = ?'); values.push(patch.revokedAt); }
			if (sets.length === 0) return false;
			sets.push('updated_at = ?');
			values.push(audit.nowIso);
			const writeAudit = auditBeforeMutation(
				id, auditActionForPatch(patch), auditChangeMask(patch), audit,
				patch.permissionsJson === undefined ? undefined : safeAuditPermissionsJson(patch.permissionsJson)!,
				patch.status, false,
			);
			const results = await raw.batch([
				raw.prepare(writeAudit.sql).bind(...writeAudit.values),
				raw.prepare(`UPDATE admin_api_keys SET ${sets.join(', ')} WHERE id = ?
					AND EXISTS (SELECT 1 FROM admin_access_key_audit WHERE id = ? AND key_id = ?)`).bind(...values, id, audit.auditId, id),
				targetWriteAuditGuard(raw, id, audit.auditId),
			]);
			return Number(results[0]?.meta.changes ?? 0) === 1;
		},
		async rotateApiKey(id, secretKey, audit) {
			validateAdminApiKeyAuditContext(audit);
			const secretKeyHash = await hashLookupKey(secretKey);
			const writeAudit = auditBeforeMutation(id, 'rotated', ADMIN_API_KEY_AUDIT_CHANGE.secret, audit, undefined, undefined, true);
			const results = await raw.batch([
				raw.prepare(writeAudit.sql).bind(...writeAudit.values),
				raw.prepare(`UPDATE admin_api_keys SET secret_key = ?, secret_key_hash = ?, key_prefix = ?, updated_at = ? WHERE id = ? AND status = 'active'
					AND EXISTS (SELECT 1 FROM admin_access_key_audit WHERE id = ? AND key_id = ?)`)
					.bind(secretKey, secretKeyHash, secretKey.slice(0, 12), audit.nowIso, id, audit.auditId, id),
				targetWriteAuditGuard(raw, id, audit.auditId),
			]);
			return Number(results[0]?.meta.changes ?? 0) === 1;
		},
		async revokeApiKey(id, audit) {
			validateAdminApiKeyAuditContext(audit);
			const writeAudit = auditBeforeMutation(id, 'revoked', ADMIN_API_KEY_AUDIT_CHANGE.status, audit, undefined, 'revoked', true);
			const results = await raw.batch([
				raw.prepare(writeAudit.sql).bind(...writeAudit.values),
				raw.prepare(`UPDATE admin_api_keys SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ? AND status = 'active'
					AND EXISTS (SELECT 1 FROM admin_access_key_audit WHERE id = ? AND key_id = ?)`)
					.bind(audit.nowIso, audit.nowIso, id, audit.auditId, id),
				targetWriteAuditGuard(raw, id, audit.auditId),
			]);
			return Number(results[0]?.meta.changes ?? 0) === 1;
		},
		async revealApiKeyWithAudit(id, audit) {
			validateAdminApiKeyAuditContext(audit);
			const writeAudit = auditBeforeMutation(id, 'revealed', 0, audit, undefined, undefined, false);
			const results = await raw.batch([
				raw.prepare(`SELECT ${KEY_COLUMNS} FROM admin_api_keys WHERE id = ?`).bind(id),
				raw.prepare(writeAudit.sql).bind(...writeAudit.values),
			]);
			const row = results[0]?.results?.[0] as KeySqlRow | undefined;
			if (!row) return null;
			if (Number(results[1]?.meta.changes ?? 0) !== 1) throw new Error('Admin API key reveal audit did not commit');
			return mapKey(row);
		},
		async listApiKeyAudit(id, { limit, before }) {
			validateAdminKeyAuditLimit(limit);
			const conditions = before ? 'AND (created_at < ? OR (created_at = ? AND id < ?))' : '';
			const values = before
				? [id, new Date(before.createdAt).toISOString(), new Date(before.createdAt).toISOString(), before.id, limit]
				: [id, limit];
			const rows = await raw.prepare(`SELECT ${AUDIT_COLUMNS} FROM admin_access_key_audit
				WHERE key_id = ? ${conditions} ORDER BY created_at DESC, id DESC LIMIT ?`)
				.bind(...values).all<AuditSqlRow>();
			return (rows.results ?? []).map(mapAdminApiKeyAuditRow);
		},
		async touchApiKey(id) {
			await raw.prepare(`UPDATE admin_api_keys SET last_used_at = datetime('now') WHERE id = ?`).bind(id).run();
		},
		async insertSession(session) {
			await raw.prepare(`INSERT INTO admin_sessions (token_hash, username, created_at, expires_at) VALUES (?, ?, ?, ?)`)
				.bind(session.tokenHash, session.username, session.createdAt, session.expiresAt).run();
		},
		async getValidSession(tokenHash, nowIso) {
			const row = await raw.prepare(`SELECT token_hash, username, created_at, expires_at FROM admin_sessions WHERE token_hash = ? AND expires_at > ?`).bind(tokenHash, nowIso).first<SessionSqlRow>();
			return row ? mapSession(row) : null;
		},
		async deleteSession(tokenHash) {
			await raw.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').bind(tokenHash).run();
		},
		async deleteExpiredSessions(nowIso) {
			await raw.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').bind(nowIso).run();
		},
	};
}
