// Review-only one-transaction bundle for a normally provisioned PostgreSQL
// database. Reuses the pinned default-ACL snapshot/restore contract, replacing
// only its empty-history parent proposal with the legacy-aware variant and
// adding the replay parent gate before COMMIT.
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { buildRequestParentDefaultAclActivation } from './build-request-parent-default-acl-activation.mjs';
import { buildRequestLegacyParentActivation } from './build-request-legacy-parent-activation.mjs';

const originalParent = new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-parent-deadline-budget.sql', import.meta.url);
const gateProposal = new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-replay-parent-gate.sql', import.meta.url);
const reservationProposal = new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-replay-reservations.sql', import.meta.url);
const formalMigrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const expectedGateSha256 = '1079eb858811c70dd850b95be68f64e5c7b8361926e8c3f0a9e80621f6125b10';
const expectedReservationSha256 = 'c288bbc43fad3bbb8b3b1a88fa1b1d01b9e5f2f9f520753873e0cdf21643c3d8';
const expectedFormalCorpusSha256 = '23afef61a8a670e0af8c90e3a138f522e6b283b454e380a592bf85bca83108dc';

async function exactMigrationLedgerPreflight() {
  const versions = (await readdir(formalMigrations)).filter(name => name.endsWith('.sql')).sort();
  if (versions.length !== 73 || versions.at(-1) !== '0073_recovery_api_key_workspace_lock.sql'
    || versions.some(name => !/^\d{4}_[a-z0-9_]+\.sql$/.test(name))) {
    throw new Error('Formal PostgreSQL migration version set changed; review legacy parent switch');
  }
  const corpus = await Promise.all(versions.map(async version =>
    `${version}\n${await readFile(new URL(version, formalMigrations), 'utf8')}`));
  const corpusSha256 = createHash('sha256').update(corpus.join('\n')).digest('hex');
  if (corpusSha256 !== expectedFormalCorpusSha256) {
    throw new Error('Formal PostgreSQL migration corpus changed; review legacy parent switch');
  }
  const expectedRows = versions.map(version => `    ('${version}')`).join(',\n');
  return `-- The switch is reviewed against the full formal 0001..0073 ledger.
-- A terminal 0073 row alone does not prove that intervening versions exist.
-- Freeze even writers that do not take the migration advisory lock. The
-- surrounding transaction's 2s lock_timeout bounds this extra wait.
LOCK TABLE cinatoken_gateway.schema_migrations IN SHARE MODE;
DO $legacy_parent_migration_ledger$
BEGIN
  IF EXISTS (
    WITH expected(version) AS (VALUES
${expectedRows}
    )
    (SELECT version FROM expected
     EXCEPT SELECT version FROM cinatoken_gateway.schema_migrations)
    UNION ALL
    (SELECT version FROM cinatoken_gateway.schema_migrations
     EXCEPT SELECT version FROM expected)
  ) THEN
    RAISE EXCEPTION 'Legacy parent formal migration ledger differs from reviewed 0001..0073';
  END IF;
END;
$legacy_parent_migration_ledger$;
`;
}

async function criticalReplayReservationPreflight() {
  const source = await readFile(reservationProposal, 'utf8');
  if (createHash('sha256').update(source).digest('hex') !== expectedReservationSha256) {
    throw new Error('Pinned replay reservation proposal changed; review legacy parent switch');
  }
  function sourceBody(name) {
    const prefix = `CREATE FUNCTION cinatoken_gateway.${name}()\nRETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER\nSET search_path TO pg_catalog, pg_temp AS $reserve$`;
    if (source.split(prefix).length !== 2) {
      throw new Error(`Pinned replay reservation function ${name} changed`);
    }
    const tail = source.split(prefix)[1];
    const parts = tail.split('$reserve$;');
    if (parts.length < 2 || parts[0].includes('$expected_replay_body$')) {
      throw new Error(`Pinned replay reservation body ${name} cannot be embedded`);
    }
    return parts[0];
  }
  const intentBody = sourceBody('reserve_request_dispatch_intent_id');
  const logBody = sourceBody('reserve_request_log_replay_id');
  const triggerCheck = (table, trigger, procedure, body) => `NOT EXISTS (SELECT 1
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
      JOIN pg_catalog.pg_language l ON l.oid = p.prolang
      WHERE t.tgrelid = 'cinatoken_gateway.${table}'::pg_catalog.regclass
        AND t.tgname = '${trigger}' AND t.tgenabled = 'O'
        AND NOT t.tgisinternal AND t.tgtype = 7 AND t.tgqual IS NULL
        AND t.tgnargs = 0 AND t.tgattr::text = ''
        AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
        AND NOT t.tgdeferrable AND NOT t.tginitdeferred
        AND p.oid = 'cinatoken_gateway.${procedure}()'::pg_catalog.regprocedure
        AND p.proowner = migrator_oid AND l.lanname = 'plpgsql'
        AND p.prosecdef AND p.provolatile = 'v' AND p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
        AND p.pronargs = 0 AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::text[]
        AND p.prosrc = $expected_replay_body$${body}$expected_replay_body$)`;
  return `-- Hold source tables against trigger changes and old writes from the
-- attestation through the parent DDL and final replay census. Reasserting
-- trigger-function planner COST (irrelevant to trigger execution) takes
-- catalog tuple locks until COMMIT without masking drift in security settings.
LOCK TABLE cinatoken_gateway.request_dispatch_intents,
  cinatoken_gateway.api_key_request_logs,
  cinatoken_gateway.request_dispatch_replay_tombstones IN SHARE ROW EXCLUSIVE MODE;
ALTER FUNCTION cinatoken_gateway.reserve_request_dispatch_intent_id()
  COST 100;
ALTER FUNCTION cinatoken_gateway.reserve_request_log_replay_id()
  COST 100;
DO $legacy_parent_replay_reservation_catalog$
DECLARE migrator_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_migrator';
  IF migrator_oid IS NULL
    OR pg_catalog.current_setting('server_version_num')::integer NOT BETWEEN 180000 AND 189999
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid IN ('cinatoken_gateway.request_dispatch_intents'::pg_catalog.regclass,
        'cinatoken_gateway.api_key_request_logs'::pg_catalog.regclass,
        'cinatoken_gateway.request_dispatch_replay_tombstones'::pg_catalog.regclass)
        AND (c.relowner <> migrator_oid OR c.relkind <> 'r'
          OR c.relrowsecurity OR c.relforcerowsecurity))
    OR ${triggerCheck('request_dispatch_intents', 'request_dispatch_intents_replay_reserve', 'reserve_request_dispatch_intent_id', intentBody)}
    OR ${triggerCheck('api_key_request_logs', 'api_key_request_logs_replay_reserve', 'reserve_request_log_replay_id', logBody)} THEN
    RAISE EXCEPTION 'Legacy parent replay reservation catalog differs from reviewed source';
  END IF;
END;
$legacy_parent_replay_reservation_catalog$;
`;
}

export async function buildRequestLegacyParentDefaultAclActivation({ activation } = {}) {
  if (activation !== 'reviewed-v1') {
    throw new Error('Explicit reviewed-v1 legacy parent activation is required');
  }
  const [baseBundle, baseParent, legacyParent, gate, ledgerPreflight, reservationPreflight] = await Promise.all([
    buildRequestParentDefaultAclActivation({ activation }),
    readFile(originalParent, 'utf8'),
    buildRequestLegacyParentActivation(),
    readFile(gateProposal, 'utf8'),
    exactMigrationLedgerPreflight(),
    criticalReplayReservationPreflight(),
  ]);
  if (baseBundle.split(baseParent).length !== 2) {
    throw new Error('Pinned default-ACL activation bundle shape changed');
  }
  const gateSha256 = createHash('sha256').update(gate).digest('hex');
  if (gateSha256 !== expectedGateSha256) {
    throw new Error('Replay parent gate changed; review and repin legacy activation bundle');
  }
  const replacement = `${legacyParent.sql}\n`
    + `SET LOCAL cinatoken.request_dispatch_replay_parent_gate_activation = 'reviewed-v1';\n`
    + `-- Replay parent gate SHA-256: ${gateSha256}\n${gate}`;
  // Function replacement is required: SQL CHECK regexes contain `$'`, which
  // String.replace would otherwise interpret as the suffix of the bundle.
  const parentReplaced = baseBundle.replace(baseParent, () => replacement);
  const lockMarker = 'SELECT pg_catalog.pg_advisory_xact_lock(746923557);\n';
  if (parentReplaced.indexOf(lockMarker) < 0) {
    throw new Error('Pinned migration/parent lock ordering changed');
  }
  const sql = parentReplaced.replace(lockMarker, `${lockMarker}${ledgerPreflight}${reservationPreflight}`);
  const begin = sql.indexOf('BEGIN;\n');
  if (begin < 0 || sql.indexOf('BEGIN;\n', begin + 1) !== -1
    || !sql.endsWith('COMMIT;\n')) {
    throw new Error('Default-ACL activation transaction boundary changed');
  }
  const bodySql = sql.slice(begin + 'BEGIN;\n'.length, -'COMMIT;\n'.length);
  return Object.freeze({ sql, bodySql,
    originalParentSha256: legacyParent.sourceSha256, gateSha256,
    formalCorpusSha256: expectedFormalCorpusSha256, formalMigrationCount: 73,
    reservationSourceSha256: expectedReservationSha256 });
}
