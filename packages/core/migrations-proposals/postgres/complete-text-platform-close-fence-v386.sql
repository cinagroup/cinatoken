-- REVIEW ONLY / NON-ACTIVATABLE. This is an egress fence seam for a future
-- platform closer, NOT a buyer terminal, bill decision, or hold settlement.
-- Install after v361/v362/v365/v366/v367/v370 with the owned migrator and
-- cinatoken.complete_text_platform_close_fence_v386_activation=reviewed-v1.
-- No runtime principal may insert a fence. A future closer must replace this
-- migrator-only insert path in one coordinated, reviewed cutover.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
SELECT pg_catalog.pg_advisory_xact_lock(746923562);
SELECT pg_catalog.pg_advisory_xact_lock(746923565);
SELECT pg_catalog.pg_advisory_xact_lock(746923566);
SELECT pg_catalog.pg_advisory_xact_lock(746923567);
SELECT pg_catalog.pg_advisory_xact_lock(746923570);
SELECT pg_catalog.pg_advisory_xact_lock(746923586);
LOCK TABLE cinatoken_gateway.schema_migrations,
  cinatoken_gateway.complete_text_attempt_grants_v362,
  cinatoken_gateway.complete_text_send_custody_v365,
  cinatoken_gateway.complete_text_send_starts_v365,
  cinatoken_gateway.complete_text_result_facts_v366,
  cinatoken_gateway.complete_text_hold_renewals_v367,
  cinatoken_gateway.complete_text_no_fetch_resolutions_v370
  IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  IF CURRENT_USER<>'cinatoken_gateway_migrator'
    OR SESSION_USER<>CURRENT_USER OR migrator_oid IS NULL
    OR pg_catalog.current_setting(
      'cinatoken.complete_text_platform_close_fence_v386_activation',true)
      IS DISTINCT FROM 'reviewed-v1'
    OR (SELECT pg_catalog.count(*) FROM cinatoken_gateway.schema_migrations)<>73
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\n'
        ORDER BY version COLLATE "C")) FROM cinatoken_gateway.schema_migrations)
      <>'ca1ea96a1b4bcd0675642f30dcf48042'
    OR (SELECT nspowner FROM pg_catalog.pg_namespace
      WHERE nspname='cinatoken_gateway') IS DISTINCT FROM migrator_oid
    OR pg_catalog.to_regclass(
      'cinatoken_gateway.complete_text_platform_close_fences_v386') IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.reject_complete_text_platform_close_fence_v386()')
      IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE NOT t.tgisinternal AND t.tgenabled='O'
        AND t.tgname='complete_text_send_custody_v370_no_fetch_fence'
        AND t.tgrelid='cinatoken_gateway.complete_text_send_custody_v365'
          ::pg_catalog.regclass
        AND t.tgfoid='cinatoken_gateway.reject_complete_text_fenced_send_v370()'
          ::pg_catalog.regprocedure)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE NOT t.tgisinternal AND t.tgenabled='O'
        AND t.tgname='complete_text_send_starts_v370_no_fetch_fence'
        AND t.tgrelid='cinatoken_gateway.complete_text_send_starts_v365'
          ::pg_catalog.regclass
        AND t.tgfoid='cinatoken_gateway.reject_complete_text_fenced_send_v370()'
          ::pg_catalog.regprocedure)
  THEN RAISE EXCEPTION 'complete text platform close fence v386 activation or dependency differs'
    USING ERRCODE='23514',CONSTRAINT='complete_text_close_fence_activation_v386';
  END IF;
END;
$preflight$;

CREATE TABLE cinatoken_gateway.complete_text_platform_close_fences_v386 (
  fence_id uuid PRIMARY KEY,
  request_id text NOT NULL UNIQUE,
  grant_id uuid NOT NULL UNIQUE REFERENCES
    cinatoken_gateway.complete_text_attempt_grants_v362(grant_id),
  quote_id uuid NOT NULL,
  grant_claim_sha256 text NOT NULL
    CHECK (grant_claim_sha256 ~ '^[0-9a-f]{64}$'),
  fence_nonce uuid NOT NULL UNIQUE,
  decision_digest_sha256 text NOT NULL
    CHECK (decision_digest_sha256 ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'egress_fenced'
    CHECK (state='egress_fenced'),
  recorded_at timestamptz NOT NULL,
  writer_xid xid8 NOT NULL
);

CREATE FUNCTION cinatoken_gateway.reject_complete_text_platform_close_fence_v386()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $fence$
DECLARE grant_request text; grant_row record; latest_lease timestamptz;
BEGIN
  IF TG_TABLE_NAME='complete_text_platform_close_fences_v386' THEN
    IF TG_OP<>'INSERT' THEN
      RAISE EXCEPTION 'complete text close fence is append-only'
        USING ERRCODE='23514',CONSTRAINT='complete_text_close_fence_append_v386';
    END IF;
    IF SESSION_USER<>'cinatoken_gateway_migrator'
      OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
      OR NEW.fence_id IS NULL OR NEW.grant_id IS NULL
      OR NEW.request_id IS NULL OR NEW.fence_nonce IS NULL
      OR NEW.decision_digest_sha256 IS NULL
    THEN RAISE EXCEPTION 'close fence has no runtime insertion authority'
      USING ERRCODE='23514',CONSTRAINT='complete_text_close_fence_call_v386';
    END IF;
    SELECT request_id INTO grant_request FROM
      cinatoken_gateway.complete_text_attempt_grants_v362
      WHERE grant_id=NEW.grant_id;
    IF grant_request IS NULL THEN
      RAISE EXCEPTION 'close fence grant missing'
        USING ERRCODE='23514',CONSTRAINT='complete_text_close_fence_grant_v386';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(348,
      pg_catalog.hashtext(grant_request));
    SELECT * INTO grant_row FROM
      cinatoken_gateway.complete_text_attempt_grants_v362
      WHERE grant_id=NEW.grant_id FOR SHARE;
    IF grant_row.request_id IS DISTINCT FROM grant_request
      OR NEW.request_id IS DISTINCT FROM grant_request
      OR NEW.quote_id IS DISTINCT FROM grant_row.quote_id
      OR NEW.grant_claim_sha256 IS DISTINCT FROM grant_row.claim_sha256
      OR grant_row.obligation_state IS DISTINCT FROM 'unknown'
      OR EXISTS (SELECT 1 FROM
        cinatoken_gateway.complete_text_platform_close_fences_v386
        WHERE request_id=grant_request)
    THEN RAISE EXCEPTION 'close fence frozen identity differs'
      USING ERRCODE='23514',CONSTRAINT='complete_text_close_fence_grant_v386';
    END IF;
    -- A fence must not be recorded while a holder still has a live lease.
    -- This is only a database guard; a later closer must also prove that a
    -- physical stream stopped and that every producer obeys its lease.
    SELECT pg_catalog.max(lease_until) INTO latest_lease FROM (
      SELECT lease_until FROM cinatoken_gateway.complete_text_send_custody_v365
        WHERE grant_id=NEW.grant_id
      UNION ALL
      SELECT lease_until FROM cinatoken_gateway.complete_text_hold_renewals_v367
        WHERE grant_id=NEW.grant_id
    ) leases;
    IF grant_row.send_expires_at>=pg_catalog.clock_timestamp()
      OR latest_lease>=pg_catalog.clock_timestamp()
    THEN RAISE EXCEPTION 'close fence send authority still live'
      USING ERRCODE='23514',CONSTRAINT='complete_text_close_fence_live_v386';
    END IF;
    NEW.recorded_at:=pg_catalog.clock_timestamp();
    NEW.writer_xid:=pg_catalog.pg_current_xact_id();
    RETURN NEW;
  END IF;

  -- The durable grant, never a caller-supplied request on a start or custody,
  -- selects the request advisory lock. Late holder observations and separately
  -- authorized provider bills remain receivable as evidence. Neither grants
  -- a new physical send or becomes a financial resolution here.
  IF TG_TABLE_NAME='complete_text_attempt_grants_v362' THEN
    grant_request:=NEW.request_id;
  ELSE
    SELECT request_id INTO grant_request FROM
      cinatoken_gateway.complete_text_attempt_grants_v362
      WHERE grant_id=NEW.grant_id;
  END IF;
  IF grant_request IS NULL THEN
    RAISE EXCEPTION 'close fence grant/request missing'
      USING ERRCODE='23514',CONSTRAINT='complete_text_close_fence_grant_v386';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(348,
    pg_catalog.hashtext(grant_request));
  IF NEW.request_id IS DISTINCT FROM grant_request
    OR EXISTS (SELECT 1 FROM
      cinatoken_gateway.complete_text_platform_close_fences_v386
      WHERE request_id=grant_request)
  THEN RAISE EXCEPTION 'complete text egress already fenced'
    USING ERRCODE='23514',CONSTRAINT='complete_text_egress_fenced_v386';
  END IF;
  RETURN NEW;
END;
$fence$;

CREATE TRIGGER complete_text_platform_close_fences_v386_insert
  BEFORE INSERT ON cinatoken_gateway.complete_text_platform_close_fences_v386
  FOR EACH ROW EXECUTE FUNCTION
    cinatoken_gateway.reject_complete_text_platform_close_fence_v386();
CREATE TRIGGER complete_text_platform_close_fences_v386_no_mutation
  BEFORE UPDATE OR DELETE ON
    cinatoken_gateway.complete_text_platform_close_fences_v386
  FOR EACH ROW EXECUTE FUNCTION
    cinatoken_gateway.reject_complete_text_platform_close_fence_v386();
CREATE TRIGGER complete_text_platform_close_fences_v386_no_truncate
  BEFORE TRUNCATE ON cinatoken_gateway.complete_text_platform_close_fences_v386
  FOR EACH STATEMENT EXECUTE FUNCTION
    cinatoken_gateway.reject_complete_text_platform_close_fence_v386();
CREATE TRIGGER complete_text_grants_v386_close_fence
  BEFORE INSERT ON cinatoken_gateway.complete_text_attempt_grants_v362
  FOR EACH ROW EXECUTE FUNCTION
    cinatoken_gateway.reject_complete_text_platform_close_fence_v386();
CREATE TRIGGER complete_text_custody_v386_close_fence
  BEFORE INSERT ON cinatoken_gateway.complete_text_send_custody_v365
  FOR EACH ROW EXECUTE FUNCTION
    cinatoken_gateway.reject_complete_text_platform_close_fence_v386();
CREATE TRIGGER complete_text_starts_v386_close_fence
  BEFORE INSERT ON cinatoken_gateway.complete_text_send_starts_v365
  FOR EACH ROW EXECUTE FUNCTION
    cinatoken_gateway.reject_complete_text_platform_close_fence_v386();
CREATE TRIGGER complete_text_renewals_v386_close_fence
  BEFORE INSERT ON cinatoken_gateway.complete_text_hold_renewals_v367
  FOR EACH ROW EXECUTE FUNCTION
    cinatoken_gateway.reject_complete_text_platform_close_fence_v386();

REVOKE ALL ON cinatoken_gateway.complete_text_platform_close_fences_v386
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_budget_admission,
    cinatoken_gateway_buyer_settlement,
    cinatoken_gateway_complete_text_attempt_granter,
    cinatoken_gateway_complete_text_send_holder,
    cinatoken_gateway_complete_text_hold_renewer,
    cinatoken_gateway_complete_text_provider_bill,
    cinatoken_gateway_complete_text_no_fetch_resolver;
REVOKE ALL ON FUNCTION
  cinatoken_gateway.reject_complete_text_platform_close_fence_v386()
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_budget_admission,
    cinatoken_gateway_buyer_settlement,
    cinatoken_gateway_complete_text_attempt_granter,
    cinatoken_gateway_complete_text_send_holder,
    cinatoken_gateway_complete_text_hold_renewer,
    cinatoken_gateway_complete_text_provider_bill,
    cinatoken_gateway_complete_text_no_fetch_resolver;
