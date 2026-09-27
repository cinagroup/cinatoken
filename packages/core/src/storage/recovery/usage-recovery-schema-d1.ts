import type { D1Database } from '@cloudflare/workers-types';
import { RECOVERY_SCHEMA_ARTIFACT } from './usage-recovery-schema-artifact';
import { settlementDigest } from './usage-settlement-codec';

/** Egress caps, not a measured Workers memory profile. Exact expected SQL totals 10,072 UTF-8 bytes. */
export const RECOVERY_SCHEMA_SQL_BYTES = 4096;
export const RECOVERY_SCHEMA_ROW_LIMIT = RECOVERY_SCHEMA_ARTIFACT.objects.length + 1;
export class UsageRecoverySchemaError extends Error {
	constructor() { super('Usage recovery schema does not match reviewed artifact'); this.name = 'UsageRecoverySchemaError'; }
}

/**
 * One bounded, read-only main-schema snapshot. No successful-result cache, DDL,
 * caller-selected expected hashes, request state or raw SQL errors. Deployment
 * must separately pin source artifacts/DB identity and exclude concurrent DDL.
 */
export async function assertUsageRecoverySchemaD1(db: Pick<D1Database, 'prepare'>): Promise<void> {
	const expected = RECOVERY_SCHEMA_ARTIFACT.objects;
	try {
		const result = await db.prepare(`SELECT
			CASE WHEN length(type)<=16 THEN type END AS object_type,
			CASE WHEN length(name)<=128 THEN name END AS object_name,
			CASE WHEN length(tbl_name)<=128 THEN tbl_name END AS table_name,
			length(CAST(sql AS BLOB)) AS sql_bytes,
			CASE WHEN length(CAST(sql AS BLOB))<=? THEN sql END AS definition
			FROM main.sqlite_master
			WHERE tbl_name IN (${RECOVERY_SCHEMA_ARTIFACT.tables.map(() => '?').join(',')})
			OR name IN (${expected.map(() => '?').join(',')})
			ORDER BY type COLLATE BINARY,name COLLATE BINARY LIMIT ?`)
			.bind(RECOVERY_SCHEMA_SQL_BYTES, ...RECOVERY_SCHEMA_ARTIFACT.tables, ...expected.map(row => row.name), RECOVERY_SCHEMA_ROW_LIMIT)
			.all<unknown>();
		if (result.success !== true || !Array.isArray(result.results) || result.results.length !== expected.length) throw new UsageRecoverySchemaError();
		for (let index = 0; index < expected.length; index++) {
			const row = result.results[index], want = expected[index];
			if (!row || typeof row !== 'object' || Array.isArray(row)
				|| !('object_type' in row) || row.object_type !== want.type
				|| !('object_name' in row) || row.object_name !== want.name
				|| !('table_name' in row) || row.table_name !== want.table
				|| !('sql_bytes' in row) || row.sql_bytes !== want.bytes || !('definition' in row)) throw new UsageRecoverySchemaError();
			if (want.sha256 === null) {
				// SQLite-owned PK/UNIQUE autoindexes have no SQL; their table DDL is hashed too.
				if (want.type !== 'index' || row.definition !== null || want.bytes !== null) throw new UsageRecoverySchemaError();
			} else {
				if (typeof row.definition !== 'string' || row.definition.length > RECOVERY_SCHEMA_SQL_BYTES
					|| await settlementDigest(row.definition) !== want.sha256) throw new UsageRecoverySchemaError();
			}
		}
	} catch {
		// Do not expose SQL, definition text, adapter exceptions or payloads to callers/logs.
		throw new UsageRecoverySchemaError();
	}
}
