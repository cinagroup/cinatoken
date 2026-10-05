/**
 * Postgres：`system_config`（Drizzle）。
 */
import { eq } from 'drizzle-orm';
import type { PostgresDatabaseClient } from '../../storage/database-client';
import type { SystemConfigRepository } from '../../storage/gateway-repository-interfaces';
import { systemConfigTable as pgSystemConfigTable } from '../../storage/drizzle/schema.pg';
import type { SystemConfigRow } from '../system-config-types';
import { configAuditMetadata } from '../system-config-audit';
import { CONFIG_GROUP_AUDIT_COLUMNS, completeConfigSnapshots, configGroupAuditValues, mapConfigGroupAuditRow, prepareConfigGroup, validateConfigGroupAuditPage, validateConfigSnapshotKeys } from '../system-config-group';
import { applyLockedConfigGroup } from '../system-config-group-transaction';
import type { ConfigSnapshot } from '../system-config-group-types';
import type postgres from 'postgres';

async function lockConfigMutex(tx: postgres.TransactionSql<Record<string, postgres.PostgresType>>) {
	const rows = await tx.unsafe<{ id: number }[]>('SELECT id FROM cinatoken_gateway.system_config_write_mutex WHERE id = 1 FOR UPDATE', []);
	if (rows.length !== 1 || rows[0]?.id !== 1) throw new Error('Config write mutex unavailable');
}

export function createPostgresSystemConfigRepository(db: PostgresDatabaseClient): SystemConfigRepository {
	const drizzle = db.drizzle;
	const pg = db.raw;
	return {
		async getConfigSnapshots(keys) {
			const sorted = validateConfigSnapshotKeys(keys);
			const rows = await pg.unsafe<ConfigSnapshot[]>(`SELECT key, value, revision FROM cinatoken_gateway.system_config WHERE key IN (${sorted.map((_, index) => `$${index + 1}`).join(', ')}) ORDER BY key`, sorted);
			return completeConfigSnapshots(sorted, rows);
		},
		async applyConfigGroupIfRevisions(input) {
			const prepared = prepareConfigGroup(input);
			return pg.begin(tx => applyLockedConfigGroup(input, prepared, {
				lock: () => lockConfigMutex(tx),
				read: keys => tx.unsafe<ConfigSnapshot[]>(`SELECT key, value, revision FROM cinatoken_gateway.system_config WHERE key IN (${keys.map((_, index) => `$${index + 1}`).join(', ')}) ORDER BY key FOR UPDATE`, [...keys]),
				write: async (write, revision) => {
					const rows = revision === null
						? await tx.unsafe(`INSERT INTO cinatoken_gateway.system_config (key, value, description, updated_at, revision) VALUES ($1, $2, NULL, $3, $4) ON CONFLICT(key) DO NOTHING RETURNING key, revision`, [write.key, write.value, input.safeAudit.nowIso, write.revision])
						: await tx.unsafe(`UPDATE cinatoken_gateway.system_config SET value = $1, updated_at = $2, revision = $3 WHERE key = $4 AND revision = $5 RETURNING key, revision`, [write.value, input.safeAudit.nowIso, write.revision, write.key, revision]);
					if (rows.length !== 1 || rows[0]?.key !== write.key || rows[0]?.revision !== write.revision) throw new Error('Config group target did not commit');
				},
				audit: async () => {
					const rows = await tx.unsafe(`INSERT INTO cinatoken_gateway.config_group_audit (${CONFIG_GROUP_AUDIT_COLUMNS}) VALUES (${Array.from({ length: 15 }, (_, index) => `$${index + 1}`).join(', ')}) RETURNING id`, configGroupAuditValues(input, prepared.after));
					if (rows.length !== 1 || rows[0]?.id !== input.safeAudit.auditId) throw new Error('Config group audit did not commit');
				},
			}));
		},
		async listConfigGroupAudit(family, options) {
			validateConfigGroupAuditPage(family, options);
			const before = options.before;
			const values = before ? [family, before.createdAt, before.id] : [family];
			const rows = await pg.unsafe<Record<string, unknown>[]>(`SELECT ${CONFIG_GROUP_AUDIT_COLUMNS.replace('created_at', `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at`)} FROM cinatoken_gateway.config_group_audit WHERE family = $1 ${before ? 'AND (created_at < $2 OR (created_at = $2 AND id < $3))' : ''} ORDER BY config_group_audit.created_at DESC, id DESC LIMIT ${options.limit}`, values);
			return rows.map(mapConfigGroupAuditRow);
		},
		async listSystemConfigRows(): Promise<SystemConfigRow[]> {
			return drizzle
				.select({
					key: pgSystemConfigTable.key,
					value: pgSystemConfigTable.value,
					description: pgSystemConfigTable.description,
					revision: pgSystemConfigTable.revision,
				})
				.from(pgSystemConfigTable)
				.orderBy(pgSystemConfigTable.key);
		},

		async upsertSystemConfigValueWithAudit(input): Promise<void> {
			const audit = configAuditMetadata(input);
			const revision = crypto.randomUUID();
			await pg.begin(async (tx) => {
				await lockConfigMutex(tx);
				const rows = await tx.unsafe(`INSERT INTO cinatoken_gateway.system_config
					(key, value, description, updated_at, revision) VALUES ($1, $2, NULL, $3, $4)
					ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value,
						updated_at = EXCLUDED.updated_at, revision = EXCLUDED.revision RETURNING revision`,
					[input.key, input.value, input.nowIso, revision]);
				if (rows.length !== 1) throw new Error('Config write did not commit');
				const audits = await tx.unsafe<{ inserted: number }[]>(`INSERT INTO cinatoken_gateway.config_change_audit
					(id, config_key, channel, action, actor_kind, actor_id, created_at)
					VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING 1 AS inserted`, [
					input.auditId, audit.configKey, audit.channel, audit.action,
					input.actorKind, input.actorId, input.nowIso,
				]);
				if (audits.length !== 1 || audits[0]?.inserted !== 1) throw new Error('Config audit did not commit');
			});
		},

		async upsertSystemConfigValueWithAuditIfRevision(input) {
			const audit = configAuditMetadata(input);
			const revision = crypto.randomUUID();
			return pg.begin(async (tx) => {
				await lockConfigMutex(tx);
				const rows = input.expectedRevision === null
					? await tx.unsafe(`INSERT INTO cinatoken_gateway.system_config
						(key, value, description, updated_at, revision)
						VALUES ($1, $2, NULL, $3, $4)
						ON CONFLICT(key) DO NOTHING RETURNING revision`,
						[input.key, input.value, input.nowIso, revision])
					: await tx.unsafe(`UPDATE cinatoken_gateway.system_config
						SET value = $1, updated_at = $2, revision = $3
						WHERE key = $4 AND revision = $5 RETURNING revision`,
						[input.value, input.nowIso, revision, input.key, input.expectedRevision]);
				if (rows.length !== 1) return { committed: false, revision: null };
				const audits = await tx.unsafe<{ inserted: number }[]>(`INSERT INTO cinatoken_gateway.config_change_audit
					(id, config_key, channel, action, actor_kind, actor_id, created_at)
					VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING 1 AS inserted`, [
					input.auditId, audit.configKey, audit.channel, audit.action,
					input.actorKind, input.actorId, input.nowIso,
				]);
				if (audits.length !== 1 || audits[0]?.inserted !== 1) throw new Error('Config audit did not commit');
				return { committed: true, revision };
			});
		},

		async getConfig(key: string): Promise<string | null> {
			const row = await drizzle
				.select({ value: pgSystemConfigTable.value })
				.from(pgSystemConfigTable)
				.where(eq(pgSystemConfigTable.key, key))
				.limit(1);
			return row[0]?.value ?? null;
		},

		async getConfigSnapshot(key: string): Promise<{ value: string | null; revision: string | null }> {
			const rows = await drizzle
				.select({ value: pgSystemConfigTable.value, revision: pgSystemConfigTable.revision })
				.from(pgSystemConfigTable)
				.where(eq(pgSystemConfigTable.key, key))
				.limit(1);
			return rows[0] ?? { value: null, revision: null };
		},

		async getAllConfig(): Promise<Record<string, string>> {
			const rows = await drizzle.select({ key: pgSystemConfigTable.key, value: pgSystemConfigTable.value }).from(pgSystemConfigTable);
			const out: Record<string, string> = {};
			for (const row of rows) {
				if (row.value != null) out[row.key] = row.value;
			}
			return out;
		},
	};
}
