-- REVIEW ONLY. Install after formal PG73 and the v338/v339 quote, dispatch,
-- outbox and v340 snapshot-consumer proposals. No worker or queue is activated.
-- Apply as a direct migrator LOGIN in one transaction with:
--   SET LOCAL cinatoken.shared_key_economic_delivery_activation = 'reviewed-v1';
-- Provision two independent, unprivileged direct LOGIN roles first:
--   cinatoken_gateway_shared_earning_delivery
--   cinatoken_gateway_shared_earning_recovery
-- The delivery LOGIN can claim, fail, acknowledge and reconcile event IDs only.
-- The recovery LOGIN can requeue dead letters with a durable reason only.
-- The v340 consumer remains a separate LOGIN. Its committed event marker is
-- required before a delivery can be completed; producer, consumer and delivery
-- credentials must never be collapsed into the ordinary gateway runtime.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
-- Both source writers and marker writers are held through trigger creation and
-- the backfill. A pre-install consumer commits before this snapshot, or waits
-- until installation commits. No commit-time watermark is used.
LOCK TABLE cinatoken_gateway.schema_migrations,
  cinatoken_economic_outbox.shared_key_economic_events,
  cinatoken_economic_consumer.shared_key_event_consumptions
  IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid;
DECLARE runtime_oid oid;
DECLARE consumer_oid oid;
DECLARE delivery_oid oid;
DECLARE recovery_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  SELECT oid INTO consumer_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_shared_earning_consumer';
  SELECT oid INTO delivery_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_shared_earning_delivery';
  SELECT oid INTO recovery_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_shared_earning_recovery';
  IF pg_catalog.current_setting('cinatoken.shared_key_economic_delivery_activation',true)
      IS DISTINCT FROM 'reviewed-v1'
    OR CURRENT_USER<>'cinatoken_gateway_migrator' OR SESSION_USER<>CURRENT_USER
    OR migrator_oid IS NULL OR runtime_oid IS NULL OR consumer_oid IS NULL
    OR delivery_oid IS NULL OR recovery_oid IS NULL
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles
      WHERE oid IN (consumer_oid,delivery_oid,recovery_oid) AND
        (NOT rolcanlogin OR rolsuper OR rolcreaterole OR rolcreatedb
          OR rolreplication OR rolbypassrls))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles r
      WHERE r.oid IN (delivery_oid,recovery_oid) AND
        (pg_catalog.pg_has_role(r.oid,migrator_oid,'MEMBER')
          OR pg_catalog.pg_has_role(r.oid,runtime_oid,'MEMBER')
          OR pg_catalog.pg_has_role(r.oid,consumer_oid,'MEMBER')
          OR pg_catalog.pg_has_role(r.oid,'pg_read_all_data'::pg_catalog.regrole,'MEMBER')
          OR pg_catalog.pg_has_role(r.oid,'pg_write_all_data'::pg_catalog.regrole,'MEMBER')))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_default_acl d,
        LATERAL pg_catalog.aclexplode(d.defaclacl) acl
      WHERE d.defaclrole=migrator_oid AND d.defaclnamespace=0
        AND d.defaclobjtype IN ('n','f','r')
        AND acl.grantee<>migrator_oid AND acl.is_grantable)
    OR pg_catalog.to_regnamespace('cinatoken_economic_delivery') IS NOT NULL
    OR (SELECT pg_catalog.array_agg(version ORDER BY version COLLATE "C")
      FROM cinatoken_gateway.schema_migrations) IS DISTINCT FROM ARRAY[
      '0001_baseline.sql', '0002_seed.sql',
      '0003_model_modalities_released.sql', '0004_provider_api_keys.sql',
      '0005_drop_providers_api_key.sql', '0006_upstream_trace_ids.sql',
      '0007_key_limits_and_sticky_config.sql', '0008_request_timing_metrics.sql',
      '0009_first_reasoning_token_ms.sql', '0010_models_max_tokens_nullable.sql',
      '0011_provider_endpoints.sql', '0012_drop_provider_base_url_columns.sql',
      '0013_request_log_image_billing.sql', '0014_request_log_audio_billing.sql',
      '0015_single_provider_key.sql', '0016_route_surfaces_pools.sql',
      '0017_gemini_models_generate.sql', '0018_route_pool_tier_strategies.sql',
      '0019_route_strategy_canonical_ids.sql', '0020_route_pool_sticky_routing.sql',
      '0021_route_strategy_display_ids.sql', '0022_request_log_audio_characters.sql',
      '0023_admin_access_identity.sql', '0024_drop_legacy_master_key_config.sql',
      '0025_user_audit_actor_index.sql', '0026_user_charged_cost_factors.sql',
      '0027_user_portal_shared_keys.sql', '0028_portal_marketplace_config.sql',
      '0029_portal_integer_ledger.sql', '0030_chain_job_transactions.sql',
      '0031_ledger_integrity_guards.sql', '0032_key_hash_lookup.sql',
      '0033_gateway_key_secret_removal.sql', '0034_public_model_daily_stats.sql',
      '0035_request_presets.sql', '0036_guardrails.sql',
      '0037_route_data_policies.sql', '0038_organization_identity_projection.sql',
      '0039_guardrail_budget_reservations.sql', '0040_user_budget_reservations.sql',
      '0041_workspaces.sql', '0042_gateway_keys_workspace.sql',
      '0043_workspace_presets_guardrails.sql', '0044_route_routing_metadata.sql',
      '0045_route_data_policy_subject_fingerprint.sql', '0046_model_endpoints.sql',
      '0047_model_endpoint_route_subject_fingerprint.sql',
      '0048_model_endpoint_audio_capabilities.sql',
      '0049_model_endpoint_evidence_ledger.sql', '0050_management_api_keys.sql',
      '0051_gateway_key_expiry.sql', '0052_gateway_key_limits.sql',
      '0053_workspace_budgets.sql', '0054_generation_metadata_snapshots.sql',
      '0055_request_session_id.sql', '0056_generation_feedback.sql',
      '0057_guardrail_assignment_management_source.sql',
      '0058_workspace_default_guardrails.sql', '0059_account_default_guardrails.sql',
      '0060_provider_attempt_availability.sql', '0061_public_model_total_tokens.sql',
      '0062_generation_service_tier.sql', '0063_private_byok.sql',
      '0064_byok_always_use_for_provider.sql',
      '0065_guardrail_budget_settlement_basis.sql',
      '0066_workspace_budget_usage_index.sql', '0067_batch_jobs.sql',
      '0068_function_schema_resolution.sql', '0069_recovery_dispatch_intents.sql',
      '0070_recovery_settlement_facts.sql', '0071_recovery_jobs.sql',
      '0072_recovery_commit_receipts.sql',
      '0073_recovery_api_key_workspace_lock.sql'
    ]::text[]
  THEN
    RAISE EXCEPTION 'Economic delivery activation, role or migration ledger differs';
  END IF;
  IF pg_catalog.to_regclass('cinatoken_economic_outbox.shared_key_economic_events') IS NULL
    OR pg_catalog.to_regclass('cinatoken_economic_consumer.shared_key_event_consumptions') IS NULL
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid IN (
      'cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass,
      'cinatoken_economic_consumer.shared_key_event_consumptions'::pg_catalog.regclass)
      AND (c.relowner<>migrator_oid OR c.relkind<>'r'
        OR c.relrowsecurity OR c.relforcerowsecurity))
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
      WHERE conname='shared_key_event_consumptions_event_id_fkey'
        AND conrelid='cinatoken_economic_consumer.shared_key_event_consumptions'::pg_catalog.regclass
        AND confrelid='cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass
        AND contype='f' AND convalidated)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc
      WHERE oid='cinatoken_economic_consumer.consume_shared_key_economic_event(text)'::pg_catalog.regprocedure
        AND proowner=migrator_oid AND prosecdef)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles r
      WHERE r.oid IN (delivery_oid,recovery_oid) AND
        (pg_catalog.has_schema_privilege(r.oid,'cinatoken_economic_outbox','USAGE')
          OR pg_catalog.has_schema_privilege(r.oid,'cinatoken_economic_consumer','USAGE')
          OR pg_catalog.has_function_privilege(r.oid,
            'cinatoken_economic_consumer.consume_shared_key_economic_event(text)','EXECUTE')))
    OR NOT pg_catalog.has_function_privilege(consumer_oid,
      'cinatoken_economic_consumer.consume_shared_key_economic_event(text)','EXECUTE')
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger
      WHERE tgrelid='cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass
        AND tgname IN ('shared_key_economic_events_guard_insert',
          'shared_key_economic_events_verify','shared_key_economic_events_no_change',
          'shared_key_economic_events_no_truncate') AND tgenabled='O')<>4
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger
      WHERE tgrelid='cinatoken_economic_consumer.shared_key_event_consumptions'::pg_catalog.regclass
        AND tgname IN ('shared_key_event_consumptions_no_change',
          'shared_key_event_consumptions_no_truncate') AND tgenabled='O')<>2
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
      WHERE tgrelid='cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass
        AND tgname='shared_key_economic_events_guard_insert' AND tgenabled='O'
        AND tgfoid='cinatoken_economic_outbox.guard_event_insert()'::pg_catalog.regprocedure)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
      WHERE tgrelid='cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass
        AND tgname='shared_key_economic_events_verify' AND tgenabled='O'
        AND tgfoid='cinatoken_economic_outbox.verify_economic_event()'::pg_catalog.regprocedure)
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger
      WHERE tgrelid='cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass
        AND tgname IN ('shared_key_economic_events_no_change',
          'shared_key_economic_events_no_truncate') AND tgenabled='O'
        AND tgfoid='cinatoken_economic_outbox.reject_economic_fact_mutation()'::pg_catalog.regprocedure)<>2
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger
      WHERE tgrelid='cinatoken_economic_consumer.shared_key_event_consumptions'::pg_catalog.regclass
        AND tgname IN ('shared_key_event_consumptions_no_change',
          'shared_key_event_consumptions_no_truncate') AND tgenabled='O'
        AND tgfoid='cinatoken_economic_consumer.reject_consumption_mutation()'::pg_catalog.regprocedure)<>2
  THEN
    RAISE EXCEPTION 'Economic delivery source catalog or consumer guard differs';
  END IF;
END;
$preflight$;

CREATE SCHEMA cinatoken_economic_delivery AUTHORIZATION cinatoken_gateway_migrator;
REVOKE ALL ON SCHEMA cinatoken_economic_delivery FROM PUBLIC,
  cinatoken_gateway_runtime,cinatoken_gateway_shared_earning_consumer,
  cinatoken_gateway_shared_earning_delivery,
  cinatoken_gateway_shared_earning_recovery;

-- This is a transport index, not another economic fact. The only source key is
-- event_id. No quote, buyer amount, provider usage, or seller value is copied.
CREATE TABLE cinatoken_economic_delivery.shared_key_event_delivery_jobs (
  event_id text PRIMARY KEY REFERENCES
    cinatoken_economic_outbox.shared_key_economic_events(event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','leased','completed','dead_letter')),
  next_attempt_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 8),
  recovery_count integer NOT NULL DEFAULT 0 CHECK (recovery_count BETWEEN 0 AND 1000),
  claim_token uuid,
  claimed_at timestamptz,
  lease_until timestamptz,
  completed_at timestamptz,
  dead_at timestamptz,
  last_failure_code text CHECK (last_failure_code IS NULL OR
    last_failure_code COLLATE "C" ~ '^[a-z0-9_]{3,64}$'),
  CONSTRAINT shared_key_delivery_state_shape CHECK (
    (status='pending' AND claim_token IS NULL AND claimed_at IS NULL
      AND lease_until IS NULL AND completed_at IS NULL AND dead_at IS NULL)
    OR (status='leased' AND claim_token IS NOT NULL AND claimed_at IS NOT NULL
      AND lease_until>claimed_at AND completed_at IS NULL AND dead_at IS NULL)
    OR (status='completed' AND claim_token IS NULL AND claimed_at IS NULL
      AND lease_until IS NULL AND completed_at IS NOT NULL AND dead_at IS NULL)
    OR (status='dead_letter' AND claim_token IS NULL AND claimed_at IS NULL
      AND lease_until IS NULL AND completed_at IS NULL AND dead_at IS NOT NULL))
);
CREATE INDEX shared_key_delivery_pending_due
  ON cinatoken_economic_delivery.shared_key_event_delivery_jobs(next_attempt_at,event_id)
  WHERE status='pending';
CREATE INDEX shared_key_delivery_expired_lease
  ON cinatoken_economic_delivery.shared_key_event_delivery_jobs(lease_until,event_id)
  WHERE status='leased';
CREATE INDEX shared_key_delivery_dead_letter
  ON cinatoken_economic_delivery.shared_key_event_delivery_jobs(dead_at,event_id)
  WHERE status='dead_letter';

CREATE TABLE cinatoken_economic_delivery.shared_key_delivery_recoveries (
  recovery_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id text NOT NULL REFERENCES
    cinatoken_economic_outbox.shared_key_economic_events(event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  recovery_number integer NOT NULL CHECK (recovery_number BETWEEN 1 AND 1000),
  reason_code text NOT NULL CHECK (reason_code COLLATE "C" ~ '^[a-z0-9_]{3,64}$'),
  recovered_by text NOT NULL CHECK
    (recovered_by='cinatoken_gateway_shared_earning_recovery'),
  recovered_at timestamptz NOT NULL,
  UNIQUE(event_id,recovery_number)
);

CREATE FUNCTION cinatoken_economic_delivery.reject_recovery_mutation()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $reject$
BEGIN
  RAISE EXCEPTION 'Economic delivery recovery audit is append-only'
    USING ERRCODE='23514',CONSTRAINT='shared_key_delivery_recovery_append_only';
END;
$reject$;
CREATE TRIGGER shared_key_delivery_recoveries_no_change BEFORE UPDATE OR DELETE
  ON cinatoken_economic_delivery.shared_key_delivery_recoveries FOR EACH STATEMENT
  EXECUTE FUNCTION cinatoken_economic_delivery.reject_recovery_mutation();
CREATE TRIGGER shared_key_delivery_recoveries_no_truncate BEFORE TRUNCATE
  ON cinatoken_economic_delivery.shared_key_delivery_recoveries FOR EACH STATEMENT
  EXECUTE FUNCTION cinatoken_economic_delivery.reject_recovery_mutation();

CREATE FUNCTION cinatoken_economic_delivery.enqueue_event()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $enqueue$
BEGIN
  IF TG_RELID<>'cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass
    OR TG_NAME<>'shared_key_economic_events_enqueue_delivery'
    OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW' THEN
    RAISE EXCEPTION 'Economic delivery trigger binding differs';
  END IF;
  INSERT INTO cinatoken_economic_delivery.shared_key_event_delivery_jobs(event_id)
    VALUES (NEW.event_id);
  RETURN NULL;
END;
$enqueue$;
CREATE TRIGGER shared_key_economic_events_enqueue_delivery
  AFTER INSERT ON cinatoken_economic_outbox.shared_key_economic_events
  FOR EACH ROW EXECUTE FUNCTION cinatoken_economic_delivery.enqueue_event();

-- The source and marker table locks above make this backfill complete even if
-- source transactions began before installation. Already-consumed events are
-- recorded as completed only when their immutable v340 marker is present.
INSERT INTO cinatoken_economic_delivery.shared_key_event_delivery_jobs
  (event_id,status,completed_at)
SELECT e.event_id,
  CASE WHEN c.event_id IS NULL THEN 'pending' ELSE 'completed' END,
  CASE WHEN c.event_id IS NULL THEN NULL ELSE pg_catalog.clock_timestamp() END
FROM cinatoken_economic_outbox.shared_key_economic_events e
LEFT JOIN cinatoken_economic_consumer.shared_key_event_consumptions c
  ON c.event_id=e.event_id;

-- Defense in depth for backfill and every later completion. The marker may be
-- inserted in the same transaction by an owner-operated repair, but must exist
-- by COMMIT. Ordinary delivery callers have no direct table write privilege.
CREATE FUNCTION cinatoken_economic_delivery.require_completion_marker()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $marker$
BEGIN
  IF TG_RELID<>'cinatoken_economic_delivery.shared_key_event_delivery_jobs'::pg_catalog.regclass
    OR TG_NAME<>'shared_key_delivery_requires_consumer_marker'
    OR TG_LEVEL<>'ROW' OR TG_OP NOT IN ('INSERT','UPDATE') THEN
    RAISE EXCEPTION 'Economic delivery completion trigger binding differs';
  END IF;
  IF NEW.status='completed' AND NOT EXISTS (
    SELECT 1 FROM cinatoken_economic_consumer.shared_key_event_consumptions
      WHERE event_id=NEW.event_id) THEN
    RAISE EXCEPTION 'Economic delivery completion requires consumer marker'
      USING ERRCODE='23514',CONSTRAINT='shared_key_delivery_marker_required';
  END IF;
  RETURN NULL;
END;
$marker$;
CREATE CONSTRAINT TRIGGER shared_key_delivery_requires_consumer_marker
  AFTER INSERT OR UPDATE ON cinatoken_economic_delivery.shared_key_event_delivery_jobs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION cinatoken_economic_delivery.require_completion_marker();

-- Queue delivery can claim one exact event ID; an absent or not-yet-due row
-- returns no claim. Scanner delivery invokes this same function after its
-- bounded due-index selection, so the two paths share marker/lease semantics.
CREATE FUNCTION cinatoken_economic_delivery.claim_event(
  p_event_id text,p_lease_seconds integer)
RETURNS TABLE(out_event_id text,out_claim_token uuid,
  out_attempt_count integer,out_lease_until timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $claim_one$
DECLARE j cinatoken_economic_delivery.shared_key_event_delivery_jobs%ROWTYPE;
DECLARE now_at timestamptz;
BEGIN
  IF CURRENT_USER<>'cinatoken_gateway_migrator'
    OR SESSION_USER<>'cinatoken_gateway_shared_earning_delivery'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_event_id IS NULL OR pg_catalog.length(p_event_id) NOT BETWEEN 1 AND 512
    OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 5 AND 300 THEN
    RAISE EXCEPTION 'Economic delivery claim protocol differs'
      USING ERRCODE='23514',CONSTRAINT='shared_key_delivery_protocol';
  END IF;
  SELECT * INTO j FROM cinatoken_economic_delivery.shared_key_event_delivery_jobs
    WHERE event_id=p_event_id FOR UPDATE SKIP LOCKED;
  IF NOT FOUND OR j.status='completed' THEN RETURN; END IF;
  now_at:=pg_catalog.clock_timestamp();
  IF EXISTS (SELECT 1 FROM cinatoken_economic_consumer.shared_key_event_consumptions
      WHERE event_id=j.event_id) THEN
    UPDATE cinatoken_economic_delivery.shared_key_event_delivery_jobs
      SET status='completed',claim_token=NULL,claimed_at=NULL,lease_until=NULL,
        completed_at=now_at,dead_at=NULL WHERE event_id=j.event_id;
    RETURN;
  END IF;
  IF (j.status='pending' AND j.next_attempt_at>now_at)
    OR (j.status='leased' AND j.lease_until>now_at)
    OR j.status='dead_letter' THEN RETURN; END IF;
  IF j.attempt_count>=8 THEN
    UPDATE cinatoken_economic_delivery.shared_key_event_delivery_jobs
      SET status='dead_letter',claim_token=NULL,claimed_at=NULL,lease_until=NULL,
        dead_at=now_at,last_failure_code='lease_exhausted'
      WHERE event_id=j.event_id;
    RETURN;
  END IF;
  out_event_id:=j.event_id;
  out_claim_token:=pg_catalog.gen_random_uuid();
  out_attempt_count:=j.attempt_count+1;
  out_lease_until:=now_at+pg_catalog.make_interval(secs=>p_lease_seconds);
  UPDATE cinatoken_economic_delivery.shared_key_event_delivery_jobs
    SET status='leased',attempt_count=out_attempt_count,
      claim_token=out_claim_token,claimed_at=now_at,lease_until=out_lease_until,
      completed_at=NULL,dead_at=NULL
    WHERE event_id=j.event_id;
  RETURN NEXT;
END;
$claim_one$;

-- Queue handlers can classify a zero-row exact claim without reading tables.
-- Only completed (which is marker-checked) and dead_letter are terminal for
-- the Queue message. The indexed scanner still handles manually requeued jobs.
CREATE FUNCTION cinatoken_economic_delivery.inspect_event(p_event_id text)
RETURNS TABLE(out_status text,out_next_attempt_at timestamptz,
  out_lease_until timestamptz,out_attempt_count integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $inspect$
DECLARE j cinatoken_economic_delivery.shared_key_event_delivery_jobs%ROWTYPE;
BEGIN
  IF CURRENT_USER<>'cinatoken_gateway_migrator'
    OR SESSION_USER<>'cinatoken_gateway_shared_earning_delivery'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_event_id IS NULL OR pg_catalog.length(p_event_id) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'Economic delivery inspection protocol differs'
      USING ERRCODE='23514',CONSTRAINT='shared_key_delivery_protocol';
  END IF;
  SELECT * INTO j FROM cinatoken_economic_delivery.shared_key_event_delivery_jobs
    WHERE event_id=p_event_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'absent'::text,NULL::timestamptz,NULL::timestamptz,NULL::integer;
    RETURN;
  END IF;
  IF j.status='completed' AND NOT EXISTS (
    SELECT 1 FROM cinatoken_economic_consumer.shared_key_event_consumptions
      WHERE event_id=p_event_id) THEN
    RAISE EXCEPTION 'Economic delivery completion requires consumer marker'
      USING ERRCODE='23514',CONSTRAINT='shared_key_delivery_marker_required';
  END IF;
  RETURN QUERY SELECT j.status,j.next_attempt_at,j.lease_until,j.attempt_count;
END;
$inspect$;

CREATE FUNCTION cinatoken_economic_delivery.claim_events(
  p_limit integer,p_lease_seconds integer)
RETURNS TABLE(out_event_id text,out_claim_token uuid,
  out_attempt_count integer,out_lease_until timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $claim_batch$
DECLARE j record;
DECLARE scan_at timestamptz;
BEGIN
  IF CURRENT_USER<>'cinatoken_gateway_migrator'
    OR SESSION_USER<>'cinatoken_gateway_shared_earning_delivery'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
    OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 5 AND 300 THEN
    RAISE EXCEPTION 'Economic delivery batch claim protocol differs'
      USING ERRCODE='23514',CONSTRAINT='shared_key_delivery_protocol';
  END IF;
  scan_at:=pg_catalog.clock_timestamp();
  -- At most p_limit index entries from each due lane are locked. The outer
  -- limit selects at most p_limit claims, avoiding an unbounded OR/sort over
  -- the whole due population. A later call handles housekeeping rows that
  -- completed or exhausted rather than returning a claim.
  FOR j IN WITH pending AS (
      SELECT event_id,next_attempt_at AS due_at
      FROM cinatoken_economic_delivery.shared_key_event_delivery_jobs
      WHERE status='pending' AND next_attempt_at<=scan_at
      ORDER BY next_attempt_at,event_id FOR UPDATE SKIP LOCKED LIMIT p_limit
    ), expired AS (
      SELECT event_id,lease_until AS due_at
      FROM cinatoken_economic_delivery.shared_key_event_delivery_jobs
      WHERE status='leased' AND lease_until<=scan_at
      ORDER BY lease_until,event_id FOR UPDATE SKIP LOCKED LIMIT p_limit
    )
    SELECT event_id FROM (SELECT * FROM pending UNION ALL SELECT * FROM expired) due
    ORDER BY due_at,event_id LIMIT p_limit
  LOOP
    RETURN QUERY SELECT * FROM cinatoken_economic_delivery.claim_event(
      j.event_id,p_lease_seconds);
  END LOOP;
END;
$claim_batch$;

CREATE FUNCTION cinatoken_economic_delivery.ack_event(
  p_event_id text,p_claim_token uuid)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $ack$
DECLARE j cinatoken_economic_delivery.shared_key_event_delivery_jobs%ROWTYPE;
BEGIN
  IF CURRENT_USER<>'cinatoken_gateway_migrator'
    OR SESSION_USER<>'cinatoken_gateway_shared_earning_delivery'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_event_id IS NULL OR p_claim_token IS NULL THEN
    RAISE EXCEPTION 'Economic delivery ACK protocol differs'
      USING ERRCODE='23514',CONSTRAINT='shared_key_delivery_protocol';
  END IF;
  SELECT * INTO j FROM cinatoken_economic_delivery.shared_key_event_delivery_jobs
    WHERE event_id=p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Economic delivery event is absent'
      USING ERRCODE='23503',CONSTRAINT='shared_key_delivery_event_absent';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cinatoken_economic_consumer.shared_key_event_consumptions
      WHERE event_id=p_event_id) THEN
    RAISE EXCEPTION 'Economic delivery ACK requires committed consumer marker'
      USING ERRCODE='23514',CONSTRAINT='shared_key_delivery_marker_required';
  END IF;
  IF j.status='completed' THEN RETURN 'already_completed'; END IF;
  IF j.status<>'leased' OR j.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION 'Economic delivery lease token is stale'
      USING ERRCODE='23514',CONSTRAINT='shared_key_delivery_stale_claim';
  END IF;
  UPDATE cinatoken_economic_delivery.shared_key_event_delivery_jobs
    SET status='completed',claim_token=NULL,claimed_at=NULL,lease_until=NULL,
      completed_at=pg_catalog.clock_timestamp()
    WHERE event_id=p_event_id;
  RETURN 'completed';
END;
$ack$;

CREATE FUNCTION cinatoken_economic_delivery.fail_event(
  p_event_id text,p_claim_token uuid,p_failure_code text)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $fail$
DECLARE j cinatoken_economic_delivery.shared_key_event_delivery_jobs%ROWTYPE;
DECLARE now_at timestamptz;
BEGIN
  IF CURRENT_USER<>'cinatoken_gateway_migrator'
    OR SESSION_USER<>'cinatoken_gateway_shared_earning_delivery'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_event_id IS NULL OR p_claim_token IS NULL
    OR p_failure_code IS NULL
    OR p_failure_code COLLATE "C" !~ '^[a-z0-9_]{3,64}$' THEN
    RAISE EXCEPTION 'Economic delivery failure protocol differs'
      USING ERRCODE='23514',CONSTRAINT='shared_key_delivery_protocol';
  END IF;
  SELECT * INTO j FROM cinatoken_economic_delivery.shared_key_event_delivery_jobs
    WHERE event_id=p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Economic delivery event is absent'
      USING ERRCODE='23503',CONSTRAINT='shared_key_delivery_event_absent';
  END IF;
  IF j.status<>'leased' OR j.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION 'Economic delivery lease token is stale'
      USING ERRCODE='23514',CONSTRAINT='shared_key_delivery_stale_claim';
  END IF;
  now_at:=pg_catalog.clock_timestamp();
  IF EXISTS (SELECT 1 FROM cinatoken_economic_consumer.shared_key_event_consumptions
      WHERE event_id=p_event_id) THEN
    UPDATE cinatoken_economic_delivery.shared_key_event_delivery_jobs
      SET status='completed',claim_token=NULL,claimed_at=NULL,lease_until=NULL,
        completed_at=now_at WHERE event_id=p_event_id;
    RETURN 'completed';
  ELSIF j.attempt_count>=8 THEN
    UPDATE cinatoken_economic_delivery.shared_key_event_delivery_jobs
      SET status='dead_letter',claim_token=NULL,claimed_at=NULL,lease_until=NULL,
        dead_at=now_at,last_failure_code=p_failure_code
      WHERE event_id=p_event_id;
    RETURN 'dead_letter';
  ELSE
    UPDATE cinatoken_economic_delivery.shared_key_event_delivery_jobs
      SET status='pending',claim_token=NULL,claimed_at=NULL,lease_until=NULL,
        next_attempt_at=now_at+pg_catalog.make_interval(
          secs=>LEAST(3600,5*(2^(j.attempt_count-1))::integer)),
        last_failure_code=p_failure_code
      WHERE event_id=p_event_id;
    RETURN 'pending';
  END IF;
END;
$fail$;

-- An ACK response may be lost, or a last-attempt lease may expire while the
-- consumer is committing. Completion reconciliation is safe without a token
-- because the immutable consumer marker, not the delivery job, proves credit.
CREATE FUNCTION cinatoken_economic_delivery.reconcile_consumed_event(p_event_id text)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $reconcile$
DECLARE j cinatoken_economic_delivery.shared_key_event_delivery_jobs%ROWTYPE;
BEGIN
  IF CURRENT_USER<>'cinatoken_gateway_migrator'
    OR SESSION_USER<>'cinatoken_gateway_shared_earning_delivery'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_event_id IS NULL THEN
    RAISE EXCEPTION 'Economic delivery reconciliation protocol differs'
      USING ERRCODE='23514',CONSTRAINT='shared_key_delivery_protocol';
  END IF;
  SELECT * INTO j FROM cinatoken_economic_delivery.shared_key_event_delivery_jobs
    WHERE event_id=p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Economic delivery event is absent'
      USING ERRCODE='23503',CONSTRAINT='shared_key_delivery_event_absent';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cinatoken_economic_consumer.shared_key_event_consumptions
      WHERE event_id=p_event_id) THEN
    RAISE EXCEPTION 'Economic delivery completion requires consumer marker'
      USING ERRCODE='23514',CONSTRAINT='shared_key_delivery_marker_required';
  END IF;
  IF j.status='completed' THEN RETURN 'already_completed'; END IF;
  UPDATE cinatoken_economic_delivery.shared_key_event_delivery_jobs
    SET status='completed',claim_token=NULL,claimed_at=NULL,lease_until=NULL,
      completed_at=pg_catalog.clock_timestamp(),dead_at=NULL
    WHERE event_id=p_event_id;
  RETURN 'completed';
END;
$reconcile$;

CREATE FUNCTION cinatoken_economic_delivery.requeue_dead_letter(
  p_event_id text,p_reason_code text)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $requeue$
DECLARE j cinatoken_economic_delivery.shared_key_event_delivery_jobs%ROWTYPE;
DECLARE next_recovery integer;
DECLARE now_at timestamptz;
BEGIN
  IF CURRENT_USER<>'cinatoken_gateway_migrator'
    OR SESSION_USER<>'cinatoken_gateway_shared_earning_recovery'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_event_id IS NULL OR p_reason_code IS NULL
    OR p_reason_code COLLATE "C" !~ '^[a-z0-9_]{3,64}$' THEN
    RAISE EXCEPTION 'Economic delivery recovery protocol differs'
      USING ERRCODE='23514',CONSTRAINT='shared_key_delivery_protocol';
  END IF;
  SELECT * INTO j FROM cinatoken_economic_delivery.shared_key_event_delivery_jobs
    WHERE event_id=p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Economic delivery event is absent'
      USING ERRCODE='23503',CONSTRAINT='shared_key_delivery_event_absent';
  END IF;
  IF j.status<>'dead_letter' OR j.recovery_count>=1000
    OR EXISTS (SELECT 1 FROM cinatoken_economic_consumer.shared_key_event_consumptions
      WHERE event_id=p_event_id) THEN
    RAISE EXCEPTION 'Economic delivery dead letter requires manual review'
      USING ERRCODE='23514',CONSTRAINT='shared_key_delivery_recovery_state';
  END IF;
  next_recovery:=j.recovery_count+1;
  now_at:=pg_catalog.clock_timestamp();
  INSERT INTO cinatoken_economic_delivery.shared_key_delivery_recoveries
    (event_id,recovery_number,reason_code,recovered_by,recovered_at)
    VALUES (p_event_id,next_recovery,p_reason_code,SESSION_USER,now_at);
  UPDATE cinatoken_economic_delivery.shared_key_event_delivery_jobs
    SET status='pending',next_attempt_at=now_at,attempt_count=0,
      recovery_count=next_recovery,dead_at=NULL,last_failure_code=NULL
    WHERE event_id=p_event_id;
  RETURN next_recovery;
END;
$requeue$;

REVOKE ALL ON ALL TABLES IN SCHEMA cinatoken_economic_delivery
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_shared_earning_consumer,
    cinatoken_gateway_shared_earning_delivery,
    cinatoken_gateway_shared_earning_recovery;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA cinatoken_economic_delivery
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_shared_earning_consumer,
    cinatoken_gateway_shared_earning_delivery,
    cinatoken_gateway_shared_earning_recovery;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA cinatoken_economic_delivery
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_shared_earning_consumer,
    cinatoken_gateway_shared_earning_delivery,
    cinatoken_gateway_shared_earning_recovery;
GRANT USAGE ON SCHEMA cinatoken_economic_delivery
  TO cinatoken_gateway_shared_earning_delivery,
    cinatoken_gateway_shared_earning_recovery;
GRANT EXECUTE ON FUNCTION
  cinatoken_economic_delivery.claim_event(text,integer),
  cinatoken_economic_delivery.claim_events(integer,integer),
  cinatoken_economic_delivery.inspect_event(text),
  cinatoken_economic_delivery.ack_event(text,uuid),
  cinatoken_economic_delivery.fail_event(text,uuid,text),
  cinatoken_economic_delivery.reconcile_consumed_event(text)
  TO cinatoken_gateway_shared_earning_delivery;
GRANT EXECUTE ON FUNCTION
  cinatoken_economic_delivery.requeue_dead_letter(text,text)
  TO cinatoken_gateway_shared_earning_recovery;

DO $postflight$
DECLARE migrator_oid oid;
DECLARE runtime_oid oid;
DECLARE consumer_oid oid;
DECLARE delivery_oid oid;
DECLARE recovery_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  SELECT oid INTO consumer_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_shared_earning_consumer';
  SELECT oid INTO delivery_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_shared_earning_delivery';
  SELECT oid INTO recovery_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_shared_earning_recovery';
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_class
      WHERE relnamespace='cinatoken_economic_delivery'::pg_catalog.regnamespace
        AND relkind='r')<>2
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class
      WHERE relnamespace='cinatoken_economic_delivery'::pg_catalog.regnamespace
        AND relkind IN ('r','S') AND relowner<>migrator_oid)
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc
      WHERE pronamespace='cinatoken_economic_delivery'::pg_catalog.regnamespace)<>10
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      WHERE p.pronamespace='cinatoken_economic_delivery'::pg_catalog.regnamespace
        AND (p.proowner<>migrator_oid OR NOT p.prosecdef
          OR NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(p.proconfig) setting
            WHERE setting LIKE 'search_path=pg_catalog%')))
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
      WHERE tgrelid='cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass
        AND tgname='shared_key_economic_events_enqueue_delivery' AND tgenabled='O'
        AND tgfoid='cinatoken_economic_delivery.enqueue_event()'::pg_catalog.regprocedure)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
      WHERE tgrelid='cinatoken_economic_delivery.shared_key_event_delivery_jobs'::pg_catalog.regclass
        AND tgname='shared_key_delivery_requires_consumer_marker' AND tgenabled='O'
        AND tgfoid='cinatoken_economic_delivery.require_completion_marker()'::pg_catalog.regprocedure)
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger
      WHERE tgrelid='cinatoken_economic_delivery.shared_key_delivery_recoveries'::pg_catalog.regclass
        AND tgname IN ('shared_key_delivery_recoveries_no_change',
          'shared_key_delivery_recoveries_no_truncate') AND tgenabled='O'
        AND tgfoid='cinatoken_economic_delivery.reject_recovery_mutation()'::pg_catalog.regprocedure)<>2
    OR pg_catalog.has_schema_privilege(runtime_oid,'cinatoken_economic_delivery','USAGE')
    OR pg_catalog.has_schema_privilege(consumer_oid,'cinatoken_economic_delivery','USAGE')
    OR NOT pg_catalog.has_schema_privilege(delivery_oid,'cinatoken_economic_delivery','USAGE')
    OR NOT pg_catalog.has_schema_privilege(recovery_oid,'cinatoken_economic_delivery','USAGE')
    OR pg_catalog.has_schema_privilege(delivery_oid,'cinatoken_economic_delivery','CREATE')
    OR pg_catalog.has_schema_privilege(recovery_oid,'cinatoken_economic_delivery','CREATE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.oid IN
      (runtime_oid,consumer_oid,delivery_oid,recovery_oid) AND
      (pg_catalog.has_table_privilege(r.oid,
        'cinatoken_economic_delivery.shared_key_event_delivery_jobs','SELECT')
        OR pg_catalog.has_table_privilege(r.oid,
          'cinatoken_economic_delivery.shared_key_event_delivery_jobs','INSERT')
        OR pg_catalog.has_table_privilege(r.oid,
          'cinatoken_economic_delivery.shared_key_event_delivery_jobs','UPDATE')
        OR pg_catalog.has_table_privilege(r.oid,
          'cinatoken_economic_delivery.shared_key_delivery_recoveries','SELECT')))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n,
        LATERAL pg_catalog.aclexplode(COALESCE(n.nspacl,
          pg_catalog.acldefault('n',n.nspowner))) acl
      WHERE n.oid='cinatoken_economic_delivery'::pg_catalog.regnamespace
        AND (n.nspowner<>migrator_oid
          OR acl.grantee NOT IN (migrator_oid,delivery_oid,recovery_oid)
          OR (acl.grantee<>migrator_oid AND acl.is_grantable)
          OR (acl.grantee IN (delivery_oid,recovery_oid)
            AND acl.privilege_type<>'USAGE')))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c,
        LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,
          pg_catalog.acldefault((CASE WHEN c.relkind='S' THEN 'S' ELSE 'r' END)::"char",c.relowner))) acl
      WHERE c.relnamespace='cinatoken_economic_delivery'::pg_catalog.regnamespace
        AND c.relkind IN ('r','S')
        AND acl.grantee<>migrator_oid)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p,
        LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,
          pg_catalog.acldefault('f',p.proowner))) acl
      WHERE p.pronamespace='cinatoken_economic_delivery'::pg_catalog.regnamespace
        AND (acl.grantee NOT IN (migrator_oid,delivery_oid,recovery_oid)
          OR (acl.grantee<>migrator_oid AND acl.is_grantable)
          OR (acl.grantee=delivery_oid AND p.oid NOT IN (
            'cinatoken_economic_delivery.claim_event(text,integer)'::pg_catalog.regprocedure,
            'cinatoken_economic_delivery.claim_events(integer,integer)'::pg_catalog.regprocedure,
            'cinatoken_economic_delivery.inspect_event(text)'::pg_catalog.regprocedure,
            'cinatoken_economic_delivery.ack_event(text,uuid)'::pg_catalog.regprocedure,
            'cinatoken_economic_delivery.fail_event(text,uuid,text)'::pg_catalog.regprocedure,
            'cinatoken_economic_delivery.reconcile_consumed_event(text)'::pg_catalog.regprocedure))
          OR (acl.grantee=recovery_oid AND p.oid<>
            'cinatoken_economic_delivery.requeue_dead_letter(text,text)'::pg_catalog.regprocedure)))
  THEN
    RAISE EXCEPTION 'Economic delivery catalog or ACL exceeds reviewed contract';
  END IF;
END;
$postflight$;
