import type { RowDataPacket, ResultSetHeader } from "mysql2/promise";
import {
	assertManagementApiKeyAccount,
	type InsertManagementApiKeyParams,
	type ManagementApiKeyAccount,
	type ManagementApiKeyRow,
} from "../db/management-api-keys-types";
import { hashLookupKey } from "../lib/key-hash";
import type { GatewayDatabaseClient } from "./database-client";
import type { ManagementApiKeysRepository } from "./gateway-repository-interfaces";
import {
	fromMySqlDateTime,
	toMySqlDateTime,
} from "../db/mysql/mysql2-compat";

type RawManagementApiKeyRow = Omit<
	ManagementApiKeyRow,
	"created_at" | "updated_at" | "expires_at" | "last_used_at"
> & {
	created_at: string | Date;
	updated_at: string | Date;
	expires_at: string | Date | null;
	last_used_at: string | Date | null;
};

function timestamp(value: string | Date | null): string | null {
	if (value === null) return null;
	return fromMySqlDateTime(value);
}

function mapRow(row: RawManagementApiKeyRow): ManagementApiKeyRow {
	return {
		...row,
		expires_at: timestamp(row.expires_at),
		last_used_at: timestamp(row.last_used_at),
		created_at: timestamp(row.created_at) ?? String(row.created_at),
		updated_at: timestamp(row.updated_at) ?? String(row.updated_at),
	};
}

function assertInsert(params: InsertManagementApiKeyParams): void {
	assertManagementApiKeyAccount(params);
	if (!params.id || !params.createdByUserId || !params.nowIso) {
		throw new TypeError("management API key insert identity is invalid");
	}
	if (!/^sha256:[0-9a-f]{64}$/u.test(params.keyHash)) {
		throw new TypeError("management API key hash is invalid");
	}
	if (!params.keyPreview || !params.name) {
		throw new TypeError("management API key display fields are invalid");
	}
}

function d1AccountPredicate(account: ManagementApiKeyAccount): {
	sql: string;
	values: string[];
} {
	assertManagementApiKeyAccount(account);
	return account.accountType === "personal"
		? {
				sql: "account_type = 'personal' AND personal_owner_user_id = ? AND organization_id IS NULL",
				values: [account.personalOwnerUserId!],
		  }
		: {
				sql: "account_type = 'organization' AND personal_owner_user_id IS NULL AND organization_id = ?",
				values: [account.organizationId!],
		  };
}

function workspaceAccountPredicate(account: ManagementApiKeyAccount): {
	sql: string;
	values: string[];
} {
	assertManagementApiKeyAccount(account);
	return account.accountType === "personal"
		? {
				sql: "scope_type = 'personal' AND personal_owner_user_id = ? AND organization_id IS NULL",
				values: [account.personalOwnerUserId!],
		  }
		: {
				sql: "scope_type = 'organization' AND personal_owner_user_id IS NULL AND organization_id = ?",
				values: [account.organizationId!],
		  };
}

function assertActorUserId(actorUserId: string): void {
	if (!actorUserId || actorUserId.length > 512) {
		throw new TypeError("management API key audit actor is invalid");
	}
}

function managementAuditPayload(
	id: string,
	account: ManagementApiKeyAccount,
	status: "active" | "revoked",
	extra?: { name: string; expiresAt: string | null }
): string {
	return JSON.stringify({
		resource_type: "management_api_key",
		management_key_id: id,
		account_type: account.accountType,
		personal_owner_user_id: account.personalOwnerUserId,
		organization_id: account.organizationId,
		status,
		...(extra ? { name: extra.name, expires_at: extra.expiresAt } : {}),
	});
}

export function createManagementApiKeysRepository(
	client: GatewayDatabaseClient
): ManagementApiKeysRepository {
	if (client.driver === "d1") {
		const raw = client.raw;
		return {
			async getActiveBySecret(secret) {
				const keyHash = await hashLookupKey(secret);
				const row = await raw
					.prepare(
						`SELECT management_key.*
						FROM management_api_keys management_key
						LEFT JOIN users owner_user ON owner_user.id = management_key.personal_owner_user_id
						LEFT JOIN organizations owner_organization ON owner_organization.id = management_key.organization_id
						WHERE management_key.key_hash = ? AND management_key.status = 'active'
							AND (management_key.expires_at IS NULL OR management_key.expires_at > datetime('now'))
							AND (
								(management_key.account_type = 'personal' AND owner_user.status = 'active')
								OR (management_key.account_type = 'organization' AND owner_organization.status IN ('active', 'pending'))
							)`
					)
					.bind(keyHash)
					.first<RawManagementApiKeyRow>();
				if (!row) return null;
				const touched = await raw
					.prepare(
						`UPDATE management_api_keys SET last_used_at = datetime('now')
						WHERE id = ? AND status = 'active'
							AND (expires_at IS NULL OR expires_at > datetime('now'))`
					)
					.bind(row.id)
					.run();
				return (touched.meta.changes ?? 0) === 1 ? mapRow(row) : null;
			},

			async listByAccount(account, options) {
				const predicate = d1AccountPredicate(account);
				const statusSql = options?.includeRevoked
					? ""
					: " AND status = 'active'";
				const rows = await raw
					.prepare(
						`SELECT * FROM management_api_keys WHERE ${predicate.sql}${statusSql}
						ORDER BY created_at DESC, id DESC LIMIT 100`
					)
					.bind(...predicate.values)
					.all<RawManagementApiKeyRow>();
				return (rows.results ?? []).map(mapRow);
			},

			async getByIdInAccount(id, account) {
				const predicate = d1AccountPredicate(account);
				const row = await raw
					.prepare(
						`SELECT * FROM management_api_keys WHERE id = ? AND ${predicate.sql}`
					)
					.bind(id, ...predicate.values)
					.first<RawManagementApiKeyRow>();
				return row ? mapRow(row) : null;
			},

			async insert(params) {
				assertInsert(params);
				const auditId = crypto.randomUUID();
				await raw.batch([
					raw
						.prepare(
							`INSERT INTO management_api_keys (
						id, key_hash, key_preview, account_type, personal_owner_user_id,
						organization_id, name, status, expires_at, created_by_user_id,
						created_at, updated_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`
						)
						.bind(
							params.id,
							params.keyHash,
							params.keyPreview,
							params.accountType,
							params.personalOwnerUserId,
							params.organizationId,
							params.name,
							params.expiresAt,
							params.createdByUserId,
							params.nowIso,
							params.nowIso
						),
					raw
						.prepare(
							`INSERT INTO user_audit_logs (
							id, user_id, api_key_id, event_type, actor_type,
							change_payload, source, actor_id, reason_code, reason_text, created_at
						) VALUES (?, ?, NULL, 'key_created', 'user', ?,
							'portal_management_keys', ?, 'management_key_create',
							'Management API key created', ?)`
						)
						.bind(
							auditId,
							params.createdByUserId,
							managementAuditPayload(params.id, params, "active", {
								name: params.name,
								expiresAt: params.expiresAt,
							}),
							`portal:${params.createdByUserId}`,
							params.nowIso
						),
				]);
			},

			async revokeByIdInAccount(id, account, nowIso, actorUserId) {
				assertActorUserId(actorUserId);
				const predicate = d1AccountPredicate(account);
				const results = await raw.batch([
					raw
						.prepare(
							`INSERT INTO user_audit_logs (
							id, user_id, api_key_id, event_type, actor_type,
							change_payload, source, actor_id, reason_code, reason_text, created_at
						)
						SELECT ?, ?, NULL, 'key_revoked', 'user', ?,
							'portal_management_keys', ?, 'management_key_revoke',
							'Management API key revoked', ?
						FROM management_api_keys
						WHERE id = ? AND status = 'active' AND ${predicate.sql}`
						)
						.bind(
							crypto.randomUUID(),
							actorUserId,
							managementAuditPayload(id, account, "revoked"),
							`portal:${actorUserId}`,
							nowIso,
							id,
							...predicate.values
						),
					raw
						.prepare(
							`UPDATE management_api_keys SET status = 'revoked', updated_at = ?
						WHERE id = ? AND status = 'active' AND ${predicate.sql}`
						)
						.bind(nowIso, id, ...predicate.values),
				]);
				return (results[1]?.meta.changes ?? 0) === 1;
			},

			async workspaceBelongsToAccount(workspaceId, account) {
				const predicate = workspaceAccountPredicate(account);
				const row = await raw
					.prepare(
						`SELECT id FROM workspaces WHERE id = ? AND status = 'active'
						AND ${predicate.sql} LIMIT 1`
					)
					.bind(workspaceId, ...predicate.values)
					.first<{ id: string }>();
				return row !== null;
			},
		};
	}

	if (client.driver === "postgres") {
		const raw = client.raw;
		return {
			async getActiveBySecret(secret) {
				const keyHash = await hashLookupKey(secret);
				const rows = await raw<RawManagementApiKeyRow[]>`
					SELECT management_key.*
					FROM management_api_keys management_key
					LEFT JOIN users owner_user ON owner_user.id = management_key.personal_owner_user_id
					LEFT JOIN organizations owner_organization ON owner_organization.id = management_key.organization_id
					WHERE management_key.key_hash = ${keyHash}
						AND management_key.status = 'active'
						AND (management_key.expires_at IS NULL OR management_key.expires_at > CURRENT_TIMESTAMP)
						AND (
							(management_key.account_type = 'personal' AND owner_user.status = 'active')
							OR (management_key.account_type = 'organization' AND owner_organization.status IN ('active', 'pending'))
						)
					LIMIT 1
				`;
				const row = rows[0];
				if (!row) return null;
				const touched = await raw<{ id: string }[]>`
					UPDATE management_api_keys SET last_used_at = CURRENT_TIMESTAMP
					WHERE id = ${row.id} AND status = 'active'
						AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
					RETURNING id
				`;
				return touched.length === 1 ? mapRow(row) : null;
			},

			async listByAccount(account, options) {
				assertManagementApiKeyAccount(account);
				const includeRevoked = options?.includeRevoked === true;
				const rows =
					account.accountType === "personal"
						? await raw<RawManagementApiKeyRow[]>`
						SELECT * FROM management_api_keys
						WHERE account_type = 'personal'
							AND personal_owner_user_id = ${account.personalOwnerUserId}
							AND organization_id IS NULL
							AND (${includeRevoked} OR status = 'active')
						ORDER BY created_at DESC, id DESC LIMIT 100
					`
						: await raw<RawManagementApiKeyRow[]>`
						SELECT * FROM management_api_keys
						WHERE account_type = 'organization'
							AND personal_owner_user_id IS NULL
							AND organization_id = ${account.organizationId}
							AND (${includeRevoked} OR status = 'active')
						ORDER BY created_at DESC, id DESC LIMIT 100
					`;
				return rows.map(mapRow);
			},

			async getByIdInAccount(id, account) {
				assertManagementApiKeyAccount(account);
				const rows =
					account.accountType === "personal"
						? await raw<RawManagementApiKeyRow[]>`
						SELECT * FROM management_api_keys
						WHERE id = ${id} AND account_type = 'personal'
							AND personal_owner_user_id = ${account.personalOwnerUserId}
							AND organization_id IS NULL LIMIT 1
					`
						: await raw<RawManagementApiKeyRow[]>`
						SELECT * FROM management_api_keys
						WHERE id = ${id} AND account_type = 'organization'
							AND personal_owner_user_id IS NULL
							AND organization_id = ${account.organizationId} LIMIT 1
					`;
				return rows[0] ? mapRow(rows[0]) : null;
			},

			async insert(params) {
				assertInsert(params);
				await raw.begin(async (transaction) => {
					await transaction`
						INSERT INTO management_api_keys (
							id, key_hash, key_preview, account_type, personal_owner_user_id,
							organization_id, name, status, expires_at, created_by_user_id,
							created_at, updated_at
						) VALUES (
							${params.id}, ${params.keyHash}, ${params.keyPreview}, ${params.accountType},
							${params.personalOwnerUserId}, ${params.organizationId}, ${params.name},
							'active', ${params.expiresAt}, ${params.createdByUserId},
							${params.nowIso}, ${params.nowIso}
						)
					`;
					await transaction`
						INSERT INTO user_audit_logs (
							id, user_id, api_key_id, event_type, actor_type,
							change_payload, source, actor_id, reason_code, reason_text, created_at
						) VALUES (
							${crypto.randomUUID()}, ${params.createdByUserId}, NULL,
							'key_created', 'user',
							${managementAuditPayload(params.id, params, "active", {
								name: params.name,
								expiresAt: params.expiresAt,
							})},
							'portal_management_keys', ${`portal:${params.createdByUserId}`},
							'management_key_create', 'Management API key created', ${params.nowIso}
						)
					`;
				});
			},

			async revokeByIdInAccount(id, account, nowIso, actorUserId) {
				assertManagementApiKeyAccount(account);
				assertActorUserId(actorUserId);
				return raw.begin(async (transaction) => {
					const rows =
						account.accountType === "personal"
							? await transaction<{ id: string }[]>`
							UPDATE management_api_keys SET status = 'revoked', updated_at = ${nowIso}
							WHERE id = ${id} AND status = 'active' AND account_type = 'personal'
								AND personal_owner_user_id = ${account.personalOwnerUserId}
								AND organization_id IS NULL RETURNING id
						`
							: await transaction<{ id: string }[]>`
							UPDATE management_api_keys SET status = 'revoked', updated_at = ${nowIso}
							WHERE id = ${id} AND status = 'active' AND account_type = 'organization'
								AND personal_owner_user_id IS NULL
								AND organization_id = ${account.organizationId} RETURNING id
						`;
					if (rows.length !== 1) return false;
					await transaction`
						INSERT INTO user_audit_logs (
							id, user_id, api_key_id, event_type, actor_type,
							change_payload, source, actor_id, reason_code, reason_text, created_at
						) VALUES (
							${crypto.randomUUID()}, ${actorUserId}, NULL,
							'key_revoked', 'user', ${managementAuditPayload(id, account, "revoked")},
							'portal_management_keys', ${`portal:${actorUserId}`},
							'management_key_revoke', 'Management API key revoked', ${nowIso}
						)
					`;
					return true;
				});
			},

			async workspaceBelongsToAccount(workspaceId, account) {
				assertManagementApiKeyAccount(account);
				const rows =
					account.accountType === "personal"
						? await raw<{ id: string }[]>`
						SELECT id FROM workspaces WHERE id = ${workspaceId}
							AND status = 'active' AND scope_type = 'personal'
							AND personal_owner_user_id = ${account.personalOwnerUserId}
							AND organization_id IS NULL LIMIT 1
					`
						: await raw<{ id: string }[]>`
						SELECT id FROM workspaces WHERE id = ${workspaceId}
							AND status = 'active' AND scope_type = 'organization'
							AND personal_owner_user_id IS NULL
							AND organization_id = ${account.organizationId} LIMIT 1
					`;
				return rows.length === 1;
			},
		};
	}

	const raw = client.raw;
	const mysqlAccount = (account: ManagementApiKeyAccount) => {
		const predicate = d1AccountPredicate(account);
		return predicate;
	};
	return {
		async getActiveBySecret(secret) {
			const keyHash = await hashLookupKey(secret);
			const [rows] = await raw.execute<
				(RawManagementApiKeyRow & RowDataPacket)[]
			>(
				`SELECT management_key.*
				FROM management_api_keys management_key
				LEFT JOIN users owner_user ON owner_user.id = management_key.personal_owner_user_id
				LEFT JOIN organizations owner_organization ON owner_organization.id = management_key.organization_id
				WHERE management_key.key_hash = ? AND management_key.status = 'active'
					AND (management_key.expires_at IS NULL OR management_key.expires_at > UTC_TIMESTAMP(6))
					AND (
						(management_key.account_type = 'personal' AND owner_user.status = 'active')
						OR (management_key.account_type = 'organization' AND owner_organization.status IN ('active', 'pending'))
					) LIMIT 1`,
				[keyHash]
			);
			const row = rows[0];
			if (!row) return null;
			const [touched] = await raw.execute<ResultSetHeader>(
				`UPDATE management_api_keys
				SET last_used_at = UTC_TIMESTAMP(6)
				WHERE id = ? AND status = 'active'
					AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP(6))`,
				[row.id]
			);
			return touched.affectedRows === 1 ? mapRow(row) : null;
		},

		async listByAccount(account, options) {
			const predicate = mysqlAccount(account);
			const statusSql = options?.includeRevoked ? "" : " AND status = 'active'";
			const [rows] = await raw.execute<
				(RawManagementApiKeyRow & RowDataPacket)[]
			>(
				`SELECT * FROM management_api_keys WHERE ${predicate.sql}${statusSql}
				ORDER BY created_at DESC, id DESC LIMIT 100`,
				predicate.values
			);
			return rows.map(mapRow);
		},

		async getByIdInAccount(id, account) {
			const predicate = mysqlAccount(account);
			const [rows] = await raw.execute<
				(RawManagementApiKeyRow & RowDataPacket)[]
			>(
				`SELECT * FROM management_api_keys WHERE id = ? AND ${predicate.sql} LIMIT 1`,
				[id, ...predicate.values]
			);
			return rows[0] ? mapRow(rows[0]) : null;
		},

		async insert(params) {
			assertInsert(params);
			const mysqlNow = toMySqlDateTime(params.nowIso);
			const mysqlExpiresAt = params.expiresAt
				? toMySqlDateTime(params.expiresAt)
				: null;
			const connection = await raw.getConnection();
			try {
				await connection.beginTransaction();
				await connection.execute(
					`INSERT INTO management_api_keys (
					id, key_hash, key_preview, account_type, personal_owner_user_id,
					organization_id, name, status, expires_at, created_by_user_id,
					created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
					[
						params.id,
						params.keyHash,
						params.keyPreview,
						params.accountType,
						params.personalOwnerUserId,
						params.organizationId,
						params.name,
						mysqlExpiresAt,
						params.createdByUserId,
						mysqlNow,
						mysqlNow,
					]
				);
				await connection.execute(
					`INSERT INTO user_audit_logs (
						id, user_id, api_key_id, event_type, actor_type,
						change_payload, source, actor_id, reason_code, reason_text, created_at
					) VALUES (?, ?, NULL, 'key_created', 'user', ?,
						'portal_management_keys', ?, 'management_key_create',
						'Management API key created', ?)`,
					[
						crypto.randomUUID(),
						params.createdByUserId,
						managementAuditPayload(params.id, params, "active", {
							name: params.name,
							expiresAt: params.expiresAt,
						}),
						`portal:${params.createdByUserId}`,
						mysqlNow,
					]
				);
				await connection.commit();
			} catch (error) {
				await connection.rollback().catch(() => undefined);
				throw error;
			} finally {
				connection.release();
			}
		},

		async revokeByIdInAccount(id, account, nowIso, actorUserId) {
			assertActorUserId(actorUserId);
			const mysqlNow = toMySqlDateTime(nowIso);
			const predicate = mysqlAccount(account);
			const connection = await raw.getConnection();
			try {
				await connection.beginTransaction();
				const [result] = await connection.execute<ResultSetHeader>(
					`UPDATE management_api_keys
					SET status = 'revoked', updated_at = ?
					WHERE id = ? AND status = 'active' AND ${predicate.sql}`,
					[mysqlNow, id, ...predicate.values]
				);
				if (result.affectedRows !== 1) {
					await connection.rollback();
					return false;
				}
				await connection.execute(
					`INSERT INTO user_audit_logs (
						id, user_id, api_key_id, event_type, actor_type,
						change_payload, source, actor_id, reason_code, reason_text, created_at
					) VALUES (?, ?, NULL, 'key_revoked', 'user', ?,
						'portal_management_keys', ?, 'management_key_revoke',
						'Management API key revoked', ?)`,
					[
						crypto.randomUUID(),
						actorUserId,
						managementAuditPayload(id, account, "revoked"),
						`portal:${actorUserId}`,
						mysqlNow,
					]
				);
				await connection.commit();
				return true;
			} catch (error) {
				await connection.rollback().catch(() => undefined);
				throw error;
			} finally {
				connection.release();
			}
		},

		async workspaceBelongsToAccount(workspaceId, account) {
			const predicate = workspaceAccountPredicate(account);
			const [rows] = await raw.execute<RowDataPacket[]>(
				`SELECT id FROM workspaces WHERE id = ? AND status = 'active'
					AND ${predicate.sql} LIMIT 1`,
				[workspaceId, ...predicate.values]
			);
			return rows.length === 1;
		},
	};
}
