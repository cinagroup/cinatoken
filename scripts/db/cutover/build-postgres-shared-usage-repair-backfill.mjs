// Review-only historical earning -> durable usage-repair job backfill.
// No ambient database URL, new progress table, remote connection or automatic
// scheduler. A caller must retain the last committed cursor; an unknown COMMIT
// result is retried from the previous cursor, never advanced speculatively.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const historyGuard = new URL('../../../packages/core/migrations-proposals/postgres/shared-key-earnings-history-guard.sql', import.meta.url);
const repairJobs = new URL('../../../packages/core/migrations-proposals/postgres/shared-key-usage-repair-jobs.sql', import.meta.url);
const expectedHistorySha256 = '454a720f9a6b7410e0aad99c2aaa2eb3327fbbac8c86bb3e3cd4537131e6611b';
const expectedJobsSha256 = '7b2f288ecb83e34207bcfd5a2a4eec934c0d6e156190826816ab033716c173d4';
const expectedHistoryBodyMd5 = '208738196cf07b4dc3b5164b8dea0f48';
const expectedCreditBodyMd5 = '5f4867439aca9484551b83af6bb7c7f6';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function functionBodyMd5(sql, marker) {
  const startMarker = `AS $${marker}$`;
  const endMarker = `$${marker}$;`;
  const start = sql.indexOf(startMarker);
  const end = start < 0 ? -1 : sql.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0 || sql.indexOf(startMarker, start + 1) >= 0) {
    throw new Error(`Pinned ${marker} function body shape changed`);
  }
  return createHash('md5').update(sql.slice(start + startMarker.length, end)).digest('hex');
}

async function verifyReviewedSources() {
  const [history, jobs] = await Promise.all([readFile(historyGuard), readFile(repairJobs)]);
  if (hash(history) !== expectedHistorySha256 || hash(jobs) !== expectedJobsSha256) {
    throw new Error('Shared-key earning history or repair job proposal changed; review backfill again');
  }
  const historyMd5 = functionBodyMd5(history.toString('utf8'), 'reject');
  if (historyMd5 !== expectedHistoryBodyMd5) {
    throw new Error('Pinned earning history function body differs');
  }
  return { enqueueMd5: functionBodyMd5(jobs.toString('utf8'), 'enqueue') };
}

function cursorSql(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.includes('\0')
    || Buffer.from(value, 'utf8').toString('utf8') !== value) {
    throw new TypeError('Invalid earning ID cursor');
  }
  return `pg_catalog.convert_from(pg_catalog.decode('${Buffer.from(value, 'utf8').toString('hex')}','hex'),'UTF8')`;
}

export async function buildPostgresSharedUsageRepairBackfillPage({
  activation, afterEarningId = null, limit,
} = {}) {
  if (activation !== 'reviewed-v1') {
    throw new Error('Explicit reviewed-v1 historical repair backfill is required');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new TypeError('Historical repair backfill limit must be 1..500');
  }
  const cursor = cursorSql(afterEarningId);
  const { enqueueMd5 } = await verifyReviewedSources();

  // ROW EXCLUSIVE is compatible with earning INSERT, but excludes trigger DDL
  // while this one short page verifies the trigger catalog and queues jobs.
  const preflightSql = `SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
LOCK TABLE cinatoken_gateway.shared_key_earnings,
  cinatoken_gateway.shared_key_usage_repair_jobs IN ROW EXCLUSIVE MODE;
DO $repair_backfill_preflight$
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
    OR pg_catalog.current_setting('session_replication_role') <> 'origin'
    OR NOT EXISTS (SELECT 1 FROM cinatoken_gateway.schema_migrations
      WHERE version = '0073_recovery_api_key_workspace_lock.sql')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid = pg_catalog.to_regclass('cinatoken_gateway.shared_key_earnings')
        AND c.relowner = migrator_oid AND c.relkind = 'r'
        AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
      JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid
        AND a.attname = 'id' AND NOT a.attisdropped
      WHERE c.conrelid = pg_catalog.to_regclass('cinatoken_gateway.shared_key_earnings')
        AND c.contype = 'p' AND NOT c.condeferrable
        AND c.conkey = ARRAY[a.attnum]::smallint[])
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid = pg_catalog.to_regclass('cinatoken_gateway.shared_key_usage_repair_jobs')
        AND c.relowner = migrator_oid AND c.relkind = 'r'
        AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
      WHERE c.conrelid = pg_catalog.to_regclass('cinatoken_gateway.shared_key_usage_repair_jobs')
        AND c.confrelid = pg_catalog.to_regclass('cinatoken_gateway.shared_key_earnings')
        AND c.contype = 'f')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
      WHERE t.tgrelid = pg_catalog.to_regclass('cinatoken_gateway.shared_key_earnings')
        AND t.tgname = 'shared_key_earnings_enqueue_usage_repair'
        AND t.tgenabled = 'O' AND NOT t.tgisinternal AND t.tgtype = 5
        AND t.tgattr::text = '' AND t.tgqual IS NULL AND t.tgnargs = 0
        AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
        AND NOT t.tgdeferrable AND NOT t.tginitdeferred
        AND p.oid = pg_catalog.to_regprocedure('cinatoken_gateway.enqueue_shared_key_usage_repair()')
        AND p.proowner = migrator_oid AND p.prosecdef
        AND p.pronargs = 0 AND p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
        AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::text[]
        AND pg_catalog.md5(p.prosrc) = '${enqueueMd5}')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
      WHERE t.tgrelid = pg_catalog.to_regclass('cinatoken_gateway.shared_key_earnings')
        AND t.tgname = 'shared_key_earnings_history_immutable'
        AND t.tgenabled = 'O' AND NOT t.tgisinternal AND t.tgtype = 27
        AND t.tgattr::text = '' AND t.tgqual IS NULL AND t.tgnargs = 0
        AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
        AND NOT t.tgdeferrable AND NOT t.tginitdeferred
        AND p.oid = pg_catalog.to_regprocedure('cinatoken_gateway.reject_shared_key_earnings_history_mutation()')
        AND p.proowner = migrator_oid AND NOT p.prosecdef
        AND p.pronargs = 0 AND p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
        AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::text[]
        AND pg_catalog.md5(p.prosrc) = '${expectedHistoryBodyMd5}')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
      WHERE t.tgrelid = pg_catalog.to_regclass('cinatoken_gateway.shared_key_earnings')
        AND t.tgname = 'shared_key_earnings_history_no_truncate'
        AND t.tgenabled = 'O' AND NOT t.tgisinternal AND t.tgtype = 34
        AND t.tgattr::text = '' AND t.tgqual IS NULL AND t.tgnargs = 0
        AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
        AND NOT t.tgdeferrable AND NOT t.tginitdeferred
        AND p.oid = pg_catalog.to_regprocedure('cinatoken_gateway.reject_shared_key_earnings_history_mutation()')
        AND p.proowner = migrator_oid AND NOT p.prosecdef
        AND p.pronargs = 0 AND p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
        AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::text[]
        AND pg_catalog.md5(p.prosrc) = '${expectedHistoryBodyMd5}')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
      WHERE t.tgrelid = pg_catalog.to_regclass('cinatoken_gateway.shared_key_earnings')
        AND t.tgname = 'shared_key_earnings_credit_after_insert'
        AND t.tgenabled = 'O' AND NOT t.tgisinternal AND t.tgtype = 5
        AND t.tgattr::text = '' AND t.tgqual IS NULL AND t.tgnargs = 0
        AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
        AND NOT t.tgdeferrable AND NOT t.tginitdeferred
        AND p.oid = pg_catalog.to_regprocedure('cinatoken_gateway.shared_key_earnings_credit_after_insert_fn()')
        AND p.proowner = migrator_oid AND NOT p.prosecdef
        AND p.pronargs = 0 AND p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
        AND pg_catalog.md5(p.prosrc) = '${expectedCreditBodyMd5}')
  THEN
    RAISE EXCEPTION 'Historical shared-key repair backfill source contract differs';
  END IF;
  IF pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_gateway.shared_key_usage_repair_jobs',
      'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c,
      LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,
        pg_catalog.acldefault('r', c.relowner))) acl
      WHERE c.oid = 'cinatoken_gateway.shared_key_usage_repair_jobs'::pg_catalog.regclass
        AND acl.grantee <> migrator_oid) THEN
    RAISE EXCEPTION 'Historical shared-key repair backfill job ACL differs';
  END IF;
END;
$repair_backfill_preflight$;`;

  // The source ID primary key is immutable after the history guard. A late
  // lower-sorting earning is queued by the live AFTER INSERT trigger, not by
  // this cursor. DO NOTHING preserves a newer trigger job for the same key.
  const batchSql = `WITH batch AS MATERIALIZED (
  SELECT id, shared_key_id, request_log_id
  FROM cinatoken_gateway.shared_key_earnings
  ${cursor === null ? '' : `WHERE id > ${cursor}`}
  ORDER BY id
  LIMIT ${limit}
), enqueued AS (
  INSERT INTO cinatoken_gateway.shared_key_usage_repair_jobs
    (shared_key_id,request_log_id,requested_at,available_at)
  SELECT shared_key_id,request_log_id,
    pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp()
  FROM batch
  ON CONFLICT (shared_key_id) DO NOTHING
  RETURNING shared_key_id
)
SELECT count(*)::integer AS scanned,
  (SELECT count(*)::integer FROM enqueued) AS enqueued,
  max(batch.id) AS next_earning_id
FROM batch`;
  return Object.freeze({ afterEarningId, limit, preflightSql, batchSql,
    historySha256: expectedHistorySha256, jobsSha256: expectedJobsSha256,
    enqueueBodyMd5: enqueueMd5, historyBodyMd5: expectedHistoryBodyMd5 });
}

// postgres.js resolves begin() only after COMMIT is acknowledged. Never emit
// the next cursor from inside the callback or persist it before this returns.
export async function runPostgresSharedUsageRepairBackfillPage(sql, options) {
  const page = await buildPostgresSharedUsageRepairBackfillPage(options);
  const [result] = await sql.begin(async tx => {
    await tx.unsafe(page.preflightSql).simple();
    return tx.unsafe(page.batchSql);
  });
  if (!Number.isSafeInteger(result?.scanned) || !Number.isSafeInteger(result?.enqueued)
    || result.scanned < 0 || result.scanned > page.limit
    || result.enqueued < 0 || result.enqueued > result.scanned
    || (result.scanned === 0 ? result.next_earning_id !== null
      : typeof result.next_earning_id !== 'string')) {
    throw new Error('Historical shared-key repair page result differs');
  }
  return Object.freeze({ scanned: result.scanned, enqueued: result.enqueued,
    nextEarningId: result.next_earning_id, afterEarningId: page.afterEarningId });
}
