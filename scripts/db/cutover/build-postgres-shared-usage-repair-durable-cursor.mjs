// Review-only, migrator-owned cursor for the historical usage-repair backfill.
// The caller supplies a direct migrator PostgreSQL connection; this module
// never reads an ambient URL, schedules work or activates production repair.
import { buildPostgresSharedUsageRepairBackfillPage } from './build-postgres-shared-usage-repair-backfill.mjs';

const maintenanceSchema = 'cinatoken_repair_maintenance';
const cursorTable = `${maintenanceSchema}.shared_key_usage_repair_cursor`;

const cursorPreflightSql = `SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
DO $durable_cursor_preflight$
DECLARE migrator_oid oid;
DECLARE runtime_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_migrator';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_runtime';
  IF CURRENT_USER <> 'cinatoken_gateway_migrator'
    OR SESSION_USER <> 'cinatoken_gateway_migrator'
    OR migrator_oid IS NULL OR runtime_oid IS NULL
    OR pg_catalog.current_setting('transaction_isolation') <> 'read committed'
    OR pg_catalog.current_setting('session_replication_role') <> 'origin'
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n
      WHERE n.oid = pg_catalog.to_regnamespace('${maintenanceSchema}')
        AND n.nspowner = migrator_oid)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n,
      LATERAL pg_catalog.aclexplode(COALESCE(n.nspacl,
        pg_catalog.acldefault('n', n.nspowner))) acl
      WHERE n.oid = pg_catalog.to_regnamespace('${maintenanceSchema}')
        AND acl.grantee <> migrator_oid)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid = pg_catalog.to_regclass('${cursorTable}')
        AND c.relowner = migrator_oid AND c.relkind = 'r'
        AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c,
      LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,
        pg_catalog.acldefault('r', c.relowner))) acl
      WHERE c.oid = pg_catalog.to_regclass('${cursorTable}')
        AND acl.grantee <> migrator_oid)
    -- A non-inherited SET membership is still enough to assume the owner's
    -- identity or an all-data role in another session.
    OR pg_catalog.pg_has_role(runtime_oid, migrator_oid, 'MEMBER')
    OR pg_catalog.pg_has_role(runtime_oid,
      'pg_read_all_data'::pg_catalog.regrole, 'MEMBER')
    OR pg_catalog.pg_has_role(runtime_oid,
      'pg_write_all_data'::pg_catalog.regrole, 'MEMBER')
    OR pg_catalog.has_schema_privilege(runtime_oid, '${maintenanceSchema}', 'USAGE')
    OR pg_catalog.has_schema_privilege(runtime_oid, '${maintenanceSchema}', 'CREATE')
    OR pg_catalog.has_table_privilege(runtime_oid, '${cursorTable}', 'SELECT')
    OR pg_catalog.has_table_privilege(runtime_oid, '${cursorTable}', 'INSERT')
    OR pg_catalog.has_table_privilege(runtime_oid, '${cursorTable}', 'UPDATE')
    OR pg_catalog.has_table_privilege(runtime_oid, '${cursorTable}', 'DELETE')
  THEN
    RAISE EXCEPTION 'Historical repair durable cursor owner or ACL differs';
  END IF;
END;
$durable_cursor_preflight$;`;

export async function buildPostgresSharedUsageRepairDurableCursorActivation({ activation } = {}) {
  if (activation !== 'reviewed-v1') {
    throw new Error('Explicit reviewed-v1 durable repair cursor activation is required');
  }
  // Reuse the v336 source pin and target trigger/ACL preflight. Installation
  // and later pages both depend on the same reviewed historical source.
  const page = await buildPostgresSharedUsageRepairBackfillPage({
    activation: 'reviewed-v1', limit: 1,
  });
  return `${page.preflightSql}
DO $durable_cursor_activation$
BEGIN
  IF CURRENT_USER <> 'cinatoken_gateway_migrator'
    OR SESSION_USER <> 'cinatoken_gateway_migrator'
    OR pg_catalog.current_setting('cinatoken.shared_key_usage_repair_cursor_activation', true)
      IS DISTINCT FROM 'reviewed-v1'
    OR NOT pg_catalog.has_database_privilege(
      CURRENT_USER, pg_catalog.current_database(), 'CREATE')
    OR pg_catalog.to_regnamespace('${maintenanceSchema}') IS NOT NULL
  THEN
    RAISE EXCEPTION 'Historical repair durable cursor activation or database CREATE differs';
  END IF;
END;
$durable_cursor_activation$;
CREATE SCHEMA ${maintenanceSchema} AUTHORIZATION cinatoken_gateway_migrator;
REVOKE ALL ON SCHEMA ${maintenanceSchema} FROM PUBLIC;
REVOKE ALL ON SCHEMA ${maintenanceSchema} FROM cinatoken_gateway_runtime;
CREATE TABLE ${cursorTable} (
  singleton smallint PRIMARY KEY CHECK (singleton = 1),
  last_earning_id text,
  pages_committed bigint NOT NULL DEFAULT 0 CHECK (pages_committed >= 0),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);
REVOKE ALL ON ${cursorTable} FROM PUBLIC;
REVOKE ALL ON ${cursorTable} FROM cinatoken_gateway_runtime;
INSERT INTO ${cursorTable}(singleton) VALUES (1);
${cursorPreflightSql}`;
}

export async function runPostgresSharedUsageRepairDurableCursorActivation(sql, options) {
  const activationSql = await buildPostgresSharedUsageRepairDurableCursorActivation(options);
  await sql.begin(async tx => {
    await tx.unsafe("SET LOCAL cinatoken.shared_key_usage_repair_cursor_activation = 'reviewed-v1'");
    await tx.unsafe(activationSql).simple();
  });
}

function validateLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new TypeError('Durable historical repair backfill limit must be 1..500');
  }
}

function validatePageResult(result, limit) {
  if (!Number.isSafeInteger(result?.scanned) || !Number.isSafeInteger(result?.enqueued)
    || result.scanned < 0 || result.scanned > limit
    || result.enqueued < 0 || result.enqueued > result.scanned
    || (result.scanned === 0 ? result.next_earning_id !== null
      : typeof result.next_earning_id !== 'string')) {
    throw new Error('Historical shared-key repair page result differs');
  }
}

export async function runPostgresSharedUsageRepairDurablePage(sql, {
  activation, limit,
} = {}) {
  if (activation !== 'reviewed-v1') {
    throw new Error('Explicit reviewed-v1 durable repair backfill is required');
  }
  validateLimit(limit);
  // The row lock is the cross-process serialization point. At READ COMMITTED,
  // the waiter reads the committed cursor after the preceding page finishes.
  // No caller-supplied cursor is accepted, even after an unknown COMMIT result.
  return sql.begin(async tx => {
    await tx.unsafe(cursorPreflightSql).simple();
    const rows = await tx.unsafe(`SELECT last_earning_id, pages_committed
      FROM ${cursorTable} WHERE singleton = 1 FOR UPDATE`);
    if (rows.length !== 1 || (rows[0].last_earning_id !== null
      && typeof rows[0].last_earning_id !== 'string')
      || !Number.isSafeInteger(Number(rows[0].pages_committed))) {
      throw new Error('Historical repair durable cursor row differs');
    }
    const afterEarningId = rows[0].last_earning_id;
    const page = await buildPostgresSharedUsageRepairBackfillPage({
      activation, afterEarningId, limit,
    });
    await tx.unsafe(page.preflightSql).simple();
    const [result] = await tx.unsafe(page.batchSql);
    validatePageResult(result, limit);
    let nextEarningId = afterEarningId;
    let pagesCommitted = Number(rows[0].pages_committed);
    if (result.scanned > 0) {
      const updated = await tx.unsafe(`UPDATE ${cursorTable}
        SET last_earning_id = $1, pages_committed = pages_committed + 1,
          updated_at = pg_catalog.clock_timestamp()
        WHERE singleton = 1
          AND (last_earning_id IS NULL OR last_earning_id < $1)
        RETURNING last_earning_id, pages_committed`, [result.next_earning_id]);
      if (updated.length !== 1) {
        throw new Error('Historical repair durable cursor did not advance');
      }
      nextEarningId = updated[0].last_earning_id;
      pagesCommitted = Number(updated[0].pages_committed);
    }
    return Object.freeze({ scanned: result.scanned, enqueued: result.enqueued,
      afterEarningId, nextEarningId, pagesCommitted });
  });
}

export async function readPostgresSharedUsageRepairDurableCursor(sql) {
  return sql.begin(async tx => {
    await tx.unsafe(cursorPreflightSql).simple();
    // Wait for an in-flight page before reporting its committed checkpoint.
    // A 55P03 means the caller must retry the read; it is never a cursor.
    const rows = await tx.unsafe(`SELECT last_earning_id, pages_committed
      FROM ${cursorTable} WHERE singleton = 1 FOR UPDATE`);
    if (rows.length !== 1) throw new Error('Historical repair durable cursor row differs');
    return Object.freeze({ lastEarningId: rows[0].last_earning_id,
      pagesCommitted: Number(rows[0].pages_committed) });
  });
}
