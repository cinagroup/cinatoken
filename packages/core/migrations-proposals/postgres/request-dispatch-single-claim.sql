-- REVIEW ONLY, outside migrations-postgres. This conservative C03 request gate
-- permits at most one committed dispatch claim per request_id. It deliberately
-- prevents known-rejection failover too; a later policy needs separate durable
-- result evidence before this index can be replaced. It does not authorize a
-- producer, prove provider I/O, settle unknown usage, or activate recovery.
-- Execute as cinatoken_gateway_migrator in ONE explicit transaction, after:
--   SET LOCAL cinatoken.request_dispatch_single_claim_activation = 'reviewed-v1';
-- No BEGIN/COMMIT is embedded here. A failed preflight must roll back all DDL.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';
SET LOCAL search_path TO pg_catalog, pg_temp;

DO $activation$
BEGIN
  IF pg_catalog.current_setting('cinatoken.request_dispatch_single_claim_activation', true)
      IS DISTINCT FROM 'reviewed-v1' THEN
    RAISE EXCEPTION 'Explicit request dispatch single-claim activation assertion is missing';
  END IF;
END;
$activation$;

-- Serialize this review with the existing dispatch-intent definer proposal.
-- A bounded relation lock makes the duplicate preflight and index build one
-- snapshot of the writeable table; it must be measured on representative data.
SELECT pg_catalog.pg_advisory_xact_lock(746923551);
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
LOCK TABLE cinatoken_gateway.request_dispatch_intents IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid;
BEGIN
  IF pg_catalog.current_setting('cinatoken.request_dispatch_single_claim_activation', true)
      IS DISTINCT FROM 'reviewed-v1' THEN
    RAISE EXCEPTION 'Explicit request dispatch single-claim activation assertion is missing';
  END IF;
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_migrator';
  IF migrator_oid IS NULL OR CURRENT_USER <> 'cinatoken_gateway_migrator'
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace
      WHERE nspname = 'cinatoken_gateway' AND nspowner = migrator_oid)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class
      WHERE oid = 'cinatoken_gateway.request_dispatch_intents'::pg_catalog.regclass
        AND relkind = 'r' AND relowner = migrator_oid
        AND NOT relrowsecurity AND NOT relforcerowsecurity) THEN
    RAISE EXCEPTION 'Request dispatch single-claim migrator or relation contract differs';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
      WHERE tgrelid = 'cinatoken_gateway.request_dispatch_intents'::pg_catalog.regclass
        AND tgname = 'request_dispatch_intents_guard' AND tgenabled = 'O'
        AND NOT tgisinternal AND tgtype = 23
        AND NOT tgdeferrable AND NOT tginitdeferred
        AND tgfoid = pg_catalog.to_regprocedure(
          'cinatoken_gateway.guard_request_dispatch_intent()')
        AND tgqual IS NULL AND pg_catalog.cardinality(tgattr) = 0
        AND tgnargs = 0 AND tgoldtable IS NULL AND tgnewtable IS NULL) THEN
    RAISE EXCEPTION 'Request dispatch intent guard binding differs';
  END IF;
  -- The partial index is durable only while a granted claim cannot have its
  -- marker cleared. Accept exactly the formal 0069 invoker or the separately
  -- reviewed C03.5 definer body, with matching security mode. Any later guard
  -- revision requires a fresh review of this gate before activation.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_language language ON language.oid = p.prolang
      WHERE p.oid = pg_catalog.to_regprocedure(
          'cinatoken_gateway.guard_request_dispatch_intent()')
        AND p.proowner = migrator_oid AND language.lanname = 'plpgsql'
        AND p.prokind = 'f' AND p.provolatile = 'v'
        AND NOT p.proretset AND p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
        AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::text[]
        AND (
          (NOT p.prosecdef AND pg_catalog.md5(pg_catalog.replace(p.prosrc, E'\r\n', E'\n'))
            = 'd8a89494930000d0178d34c08672af46')
          OR (p.prosecdef AND pg_catalog.md5(pg_catalog.replace(p.prosrc, E'\r\n', E'\n'))
            = '5279c6d9241666ec76e612614640fb7b')
        )) THEN
    RAISE EXCEPTION 'Request dispatch intent guard source contract differs';
  END IF;
  -- Existing double claims are potential prior sends. Never silently repair,
  -- delete, classify or select a winner during this proposal.
  IF EXISTS (SELECT 1 FROM cinatoken_gateway.request_dispatch_intents
      WHERE dispatch_claim_id IS NOT NULL
      GROUP BY request_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Preexisting multiple dispatch claims for one request';
  END IF;
END;
$preflight$;

-- 0069's CHECK and forward-only guard keep the marker non-NULL after a claim,
-- including outcome_unknown. PostgreSQL's unique-index conflict check waits
-- for an in-flight sibling transaction and grants only after its rollback.
CREATE UNIQUE INDEX request_dispatch_intents_one_claim_per_request
  ON cinatoken_gateway.request_dispatch_intents(request_id)
  WHERE dispatch_claim_id IS NOT NULL;

-- No DELETE, TRUNCATE, retention, automatic backfill or runtime grant. Removing
-- a claimed row would reopen its request_id; retention remains a separate gate.
