-- REVIEW ONLY. Install after all 73 formal PostgreSQL migrations, the v338
-- shared-key quote proposal and the v339 dispatch-quote-attempt proposal.
-- No production producer, consumer, payout or runtime grant is activated here.
-- Apply as the migrator LOGIN inside one transaction after:
--   SET LOCAL cinatoken.shared_key_economic_outbox_activation = 'reviewed-v1';
-- The future producer must insert the event and every outcome INSIDE the
-- existing buyer charge/request-log transaction. A post-return insert cannot
-- satisfy this contract. A committed dispatch attempt without a log remains a
-- separate unknown/recovery case and must not be assumed free.
-- Every buyer-log insert, economic event insert and legacy earning insert
-- requires READ COMMITTED: advisory/row locks do not refresh a snapshot held
-- by REPEATABLE READ or SERIALIZABLE transactions.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
LOCK TABLE cinatoken_gateway.schema_migrations IN SHARE MODE;
LOCK TABLE cinatoken_gateway.api_key_request_logs,
  cinatoken_gateway.shared_key_earnings IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid;
DECLARE runtime_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_migrator';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_runtime';
  IF pg_catalog.current_setting('cinatoken.shared_key_economic_outbox_activation', true)
      IS DISTINCT FROM 'reviewed-v1'
    OR CURRENT_USER <> 'cinatoken_gateway_migrator'
    OR SESSION_USER <> CURRENT_USER
    OR migrator_oid IS NULL OR runtime_oid IS NULL
    OR (SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE oid=migrator_oid) IS DISTINCT FROM TRUE
    OR (SELECT rolsuper FROM pg_catalog.pg_roles WHERE oid=runtime_oid) IS TRUE
    OR pg_catalog.pg_has_role(runtime_oid, migrator_oid, 'MEMBER')
    OR pg_catalog.pg_has_role(runtime_oid, 'pg_read_all_data'::pg_catalog.regrole, 'MEMBER')
    OR pg_catalog.pg_has_role(runtime_oid, 'pg_write_all_data'::pg_catalog.regrole, 'MEMBER')
    OR pg_catalog.to_regnamespace('cinatoken_economic_outbox') IS NOT NULL
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
    OR pg_catalog.to_regclass('cinatoken_economic_quotes.shared_key_quote_versions') IS NULL
    OR pg_catalog.to_regclass('cinatoken_economic_quotes.shared_key_quote_transitions') IS NULL
    OR pg_catalog.to_regclass('cinatoken_economic_quotes.shared_key_dispatch_quote_attempts') IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE
      oid='cinatoken_gateway.api_key_request_logs'::pg_catalog.regclass
      AND relowner=migrator_oid AND relkind='r' AND NOT relrowsecurity AND NOT relforcerowsecurity)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE
      oid='cinatoken_gateway.shared_key_earnings'::pg_catalog.regclass
      AND relowner=migrator_oid AND relkind='r' AND NOT relrowsecurity AND NOT relforcerowsecurity)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE
      oid='cinatoken_economic_quotes.shared_key_dispatch_quote_attempts'::pg_catalog.regclass
      AND relowner=migrator_oid AND relkind='r' AND NOT relrowsecurity AND NOT relforcerowsecurity)
    -- This bridge must be installed before any enrolled buyer log has committed.
    -- Already settled attempts need a separate historical audit, never an
    -- after-the-fact event that falsely claims atomic buyer settlement.
    OR EXISTS (SELECT 1
      FROM cinatoken_economic_quotes.shared_key_dispatch_quote_attempts AS a
      JOIN cinatoken_gateway.api_key_request_logs AS l
        ON l.id=a.request_log_id)
  THEN
    RAISE EXCEPTION 'Shared-key economic outbox activation or dependency differs';
  END IF;
END;
$preflight$;

CREATE SCHEMA cinatoken_economic_outbox AUTHORIZATION cinatoken_gateway_migrator;
REVOKE ALL ON SCHEMA cinatoken_economic_outbox FROM PUBLIC, cinatoken_gateway_runtime;

-- One immutable event per buyer settlement/request log. event_id deliberately
-- equals request_log_id so a future consumer can use the existing legacy
-- shared_key_earnings.request_log_id uniqueness as a cutover check. This v1
-- event type is not an adjustment or a provider invoice.
CREATE TABLE cinatoken_economic_outbox.shared_key_economic_events (
  event_id text PRIMARY KEY,
  request_log_id text NOT NULL UNIQUE,
  event_type text NOT NULL CHECK (event_type='shared_key_usage_settled'),
  event_version integer NOT NULL CHECK (event_version=1),
  buyer_user_id text NOT NULL,
  buyer_api_key_id text NOT NULL,
  workspace_id text NOT NULL,
  buyer_charge_basis text NOT NULL
    CHECK (buyer_charge_basis IN ('actual','reserved','none')),
  buyer_usage_certainty text NOT NULL
    CHECK (buyer_usage_certainty IN ('actual','unknown')),
  buyer_charged_cost numeric(18,6) NOT NULL
    CHECK (buyer_charged_cost>=0 AND buyer_charged_cost<>'NaN'::numeric),
  buyer_budget_charged_micros bigint NOT NULL
    CHECK (buyer_budget_charged_micros BETWEEN 0 AND 9007199254740991),
  buyer_input_tokens bigint NOT NULL CHECK (buyer_input_tokens>=0),
  buyer_output_tokens bigint NOT NULL CHECK (buyer_output_tokens>=0),
  buyer_cache_read_tokens bigint NOT NULL CHECK (buyer_cache_read_tokens>=0),
  buyer_cache_write_tokens bigint NOT NULL CHECK (buyer_cache_write_tokens>=0),
  attempt_count integer NOT NULL CHECK (attempt_count BETWEEN 1 AND 1000),
  event_certainty text NOT NULL CHECK (event_certainty IN ('confirmed','unresolved')),
  recorded_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT shared_key_economic_event_identity CHECK
    (event_id=request_log_id AND pg_catalog.length(event_id) BETWEEN 1 AND 512),
  CONSTRAINT shared_key_economic_buyer_basis CHECK (
    (buyer_charge_basis='actual' AND buyer_usage_certainty='actual')
    OR (buyer_charge_basis='reserved' AND buyer_usage_certainty='unknown')
    OR (buyer_charge_basis='none' AND buyer_budget_charged_micros=0)),
  CONSTRAINT shared_key_economic_event_request_pair UNIQUE (event_id,request_log_id),
  CONSTRAINT shared_key_economic_event_log FOREIGN KEY (request_log_id)
    REFERENCES cinatoken_gateway.api_key_request_logs(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX shared_key_economic_events_scan
  ON cinatoken_economic_outbox.shared_key_economic_events(recorded_at,event_id);

-- A row for EVERY shared-key attempt registered before egress. The immutable
-- dispatch row supplies the exact quote/owner claimed before the physical send;
-- endpoint availability records do not contain financial evidence and expire.
-- Known zero is distinct from unknown. Estimated/unknown values cannot silently
-- become withdrawable earnings; a future consumer must enforce that policy.
CREATE TABLE cinatoken_economic_outbox.shared_key_economic_event_attempts (
  event_id text NOT NULL,
  request_log_id text NOT NULL,
  attempt_id uuid NOT NULL,
  attempt_index integer NOT NULL CHECK (attempt_index BETWEEN 1 AND 1000),
  shared_key_id text NOT NULL,
  transition_id text NOT NULL,
  quote_version_id text NOT NULL,
  usage_certainty text NOT NULL
    CHECK (usage_certainty IN ('actual','estimated','unknown','confirmed_zero')),
  input_tokens bigint,
  output_tokens bigint,
  cache_read_tokens bigint,
  cache_write_tokens bigint,
  provider_cost_certainty text NOT NULL
    CHECK (provider_cost_certainty IN ('actual','estimated','unknown','confirmed_zero')),
  provider_cost_micros bigint CHECK
    (provider_cost_micros IS NULL OR provider_cost_micros BETWEEN 0 AND 9007199254740991),
  evidence_kind text NOT NULL CHECK (evidence_kind IN
    ('provider_usage','provider_bill','confirmed_rejection','timeout','cancellation','manual_review')),
  evidence_sha256 text CHECK (evidence_sha256 IS NULL OR
    evidence_sha256 COLLATE "C" ~ '^[0-9a-f]{64}$'),
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (event_id,attempt_id),
  UNIQUE (attempt_id),
  UNIQUE (event_id,attempt_index),
  CONSTRAINT shared_key_economic_attempt_usage_shape CHECK (
    ((usage_certainty IN ('actual','estimated','confirmed_zero'))
      AND input_tokens IS NOT NULL AND input_tokens>=0
      AND output_tokens IS NOT NULL AND output_tokens>=0
      AND cache_read_tokens IS NOT NULL AND cache_read_tokens>=0
      AND cache_write_tokens IS NOT NULL AND cache_write_tokens>=0)
    OR (usage_certainty='unknown' AND input_tokens IS NULL AND output_tokens IS NULL
      AND cache_read_tokens IS NULL AND cache_write_tokens IS NULL)),
  CONSTRAINT shared_key_economic_attempt_zero_usage CHECK
    (usage_certainty<>'confirmed_zero' OR
      (input_tokens=0 AND output_tokens=0 AND cache_read_tokens=0 AND cache_write_tokens=0)),
  CONSTRAINT shared_key_economic_attempt_cost_shape CHECK (
    (provider_cost_certainty IN ('actual','estimated') AND provider_cost_micros IS NOT NULL)
    OR (provider_cost_certainty='unknown' AND provider_cost_micros IS NULL)
    OR (provider_cost_certainty='confirmed_zero' AND provider_cost_micros=0)),
  CONSTRAINT shared_key_economic_attempt_evidence CHECK
    ((usage_certainty IN ('actual','estimated') OR provider_cost_certainty IN ('actual','estimated'))
      IS NOT TRUE OR evidence_sha256 IS NOT NULL),
  CONSTRAINT shared_key_economic_attempt_event FOREIGN KEY (event_id,request_log_id)
    REFERENCES cinatoken_economic_outbox.shared_key_economic_events(event_id,request_log_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT shared_key_economic_attempt_quote FOREIGN KEY
    (attempt_id,request_log_id,attempt_index,transition_id,quote_version_id,shared_key_id)
    REFERENCES cinatoken_economic_quotes.shared_key_dispatch_quote_attempts
      (attempt_id,request_log_id,attempt_index,transition_id,quote_version_id,shared_key_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

-- Serialize legacy synchronous earning inserts and new outbox inserts through
-- the SAME request-log row. A new event cannot adopt an already-paid log, and
-- the still-running old settleSharedKeyEarning path cannot pay an enrolled log.
-- A later consumer needs a separate event-keyed ledger/cutover protocol before
-- this guard can be replaced. This proposal creates no payout path.
CREATE FUNCTION cinatoken_economic_outbox.guard_event_insert()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $guard$
DECLARE present boolean;
BEGIN
  IF TG_RELID<>'cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass
    OR TG_NAME<>'shared_key_economic_events_guard_insert'
    OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW' THEN
    RAISE EXCEPTION 'Economic event insert trigger binding differs';
  END IF;
  -- A transaction-level snapshot can hide an earning committed while this
  -- writer waited for the request-log row lock. Reject it before the lookup.
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Economic event insertion requires READ COMMITTED'
      USING ERRCODE='23514', CONSTRAINT='shared_key_economic_isolation';
  END IF;
  SELECT TRUE INTO present FROM cinatoken_gateway.api_key_request_logs
    WHERE id=NEW.request_log_id FOR UPDATE;
  IF present IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'Economic event requires a buyer request log'
      USING ERRCODE='23514', CONSTRAINT='shared_key_economic_log_required';
  END IF;
  IF EXISTS (SELECT 1 FROM cinatoken_gateway.shared_key_earnings
      WHERE request_log_id=NEW.request_log_id) THEN
    RAISE EXCEPTION 'Legacy earnings already paid for economic event'
      USING ERRCODE='23514', CONSTRAINT='shared_key_economic_legacy_paid';
  END IF;
  NEW.recorded_at:=pg_catalog.clock_timestamp();
  RETURN NEW;
END;
$guard$;
CREATE TRIGGER shared_key_economic_events_guard_insert
  BEFORE INSERT ON cinatoken_economic_outbox.shared_key_economic_events
  FOR EACH ROW EXECUTE FUNCTION cinatoken_economic_outbox.guard_event_insert();

CREATE FUNCTION cinatoken_economic_outbox.guard_legacy_earning_insert()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $guard$
DECLARE present boolean;
BEGIN
  IF TG_RELID<>'cinatoken_gateway.shared_key_earnings'::pg_catalog.regclass
    OR TG_NAME<>'shared_key_earnings_reject_economic_event'
    OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW' THEN
    RAISE EXCEPTION 'Legacy earning guard trigger binding differs';
  END IF;
  -- With REPEATABLE READ a competing economic event can remain invisible
  -- even after the request-log row lock has become available.
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Legacy earning insertion requires READ COMMITTED'
      USING ERRCODE='23514', CONSTRAINT='shared_key_economic_isolation';
  END IF;
  SELECT TRUE INTO present FROM cinatoken_gateway.api_key_request_logs
    WHERE id=NEW.request_log_id FOR UPDATE;
  IF present IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'Legacy earning requires a buyer request log'
      USING ERRCODE='23514', CONSTRAINT='shared_key_legacy_log_required';
  END IF;
  IF EXISTS (SELECT 1 FROM cinatoken_economic_outbox.shared_key_economic_events
      WHERE request_log_id=NEW.request_log_id) THEN
    RAISE EXCEPTION 'Legacy earning cannot pay an economic event'
      USING ERRCODE='23514', CONSTRAINT='shared_key_economic_legacy_double_pay';
  END IF;
  RETURN NEW;
END;
$guard$;
CREATE TRIGGER shared_key_earnings_reject_economic_event
  BEFORE INSERT ON cinatoken_gateway.shared_key_earnings
  FOR EACH ROW EXECUTE FUNCTION cinatoken_economic_outbox.guard_legacy_earning_insert();

-- The existing critical writer inserts api_key_request_logs in the buyer
-- balance/reservation transaction. If a pre-dispatch shared-key attempt exists,
-- that same COMMIT must include exactly one typed event and all attempt outcomes.
-- Its first database lock is the same request-scoped advisory transaction lock
-- taken FIRST by claim_shared_key_dispatch_quote_attempt. A concurrent attempt
-- cannot appear after the deferred coverage check and before buyer COMMIT.
CREATE FUNCTION cinatoken_economic_outbox.lock_request_economic_enrollment()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $lock$
BEGIN
  IF TG_RELID<>'cinatoken_gateway.api_key_request_logs'::pg_catalog.regclass
    OR TG_NAME<>'api_key_request_logs_lock_shared_quote_attempts'
    OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW' THEN
    RAISE EXCEPTION 'Economic enrollment lock trigger binding differs';
  END IF;
  -- An older transaction snapshot could miss a quote attempt that committed
  -- before this advisory lock was acquired. The guard applies to every log
  -- insert because that stale snapshot cannot safely classify the request.
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Buyer request log insertion requires READ COMMITTED'
      USING ERRCODE='23514', CONSTRAINT='shared_key_economic_isolation';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('shared_quote_attempt:' || NEW.id,0));
  RETURN NEW;
END;
$lock$;
CREATE TRIGGER api_key_request_logs_lock_shared_quote_attempts
  BEFORE INSERT ON cinatoken_gateway.api_key_request_logs FOR EACH ROW
  EXECUTE FUNCTION cinatoken_economic_outbox.lock_request_economic_enrollment();

CREATE FUNCTION cinatoken_economic_outbox.require_event_for_buyer_log()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $require$
BEGIN
  IF TG_RELID<>'cinatoken_gateway.api_key_request_logs'::pg_catalog.regclass
    OR TG_NAME<>'api_key_request_logs_require_shared_key_economic_event'
    OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW' THEN
    RAISE EXCEPTION 'Economic buyer-log trigger binding differs';
  END IF;
  IF EXISTS (SELECT 1 FROM cinatoken_economic_quotes.shared_key_dispatch_quote_attempts
      WHERE request_log_id=NEW.id)
    AND NOT EXISTS (SELECT 1 FROM cinatoken_economic_outbox.shared_key_economic_events
      WHERE request_log_id=NEW.id) THEN
    RAISE EXCEPTION 'Shared-key buyer log has no economic event'
      USING ERRCODE='23514', CONSTRAINT='shared_key_economic_event_required';
  END IF;
  RETURN NULL;
END;
$require$;
CREATE CONSTRAINT TRIGGER api_key_request_logs_require_shared_key_economic_event
  AFTER INSERT ON cinatoken_gateway.api_key_request_logs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION cinatoken_economic_outbox.require_event_for_buyer_log();

CREATE FUNCTION cinatoken_economic_outbox.verify_economic_event()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $verify$
DECLARE log_row record;
DECLARE expected_count integer;
DECLARE actual_count integer;
DECLARE unresolved_count integer;
BEGIN
  IF TG_RELID<>'cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass
    OR TG_NAME<>'shared_key_economic_events_verify'
    OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW' THEN
    RAISE EXCEPTION 'Economic event validation trigger binding differs';
  END IF;
  SELECT l.user_id,l.api_key_id,l.workspace_id,l.charged_cost,
    l.budget_charged_micros,l.input_tokens,l.output_tokens,
    l.cache_read_tokens,l.cache_write_tokens
    INTO log_row FROM cinatoken_gateway.api_key_request_logs AS l
    WHERE l.id=NEW.request_log_id;
  IF NOT FOUND OR log_row.user_id IS DISTINCT FROM NEW.buyer_user_id
    OR log_row.api_key_id IS DISTINCT FROM NEW.buyer_api_key_id
    OR log_row.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR log_row.charged_cost IS DISTINCT FROM NEW.buyer_charged_cost
    OR log_row.budget_charged_micros IS DISTINCT FROM NEW.buyer_budget_charged_micros
    OR log_row.input_tokens IS DISTINCT FROM NEW.buyer_input_tokens
    OR log_row.output_tokens IS DISTINCT FROM NEW.buyer_output_tokens
    OR log_row.cache_read_tokens IS DISTINCT FROM NEW.buyer_cache_read_tokens
    OR log_row.cache_write_tokens IS DISTINCT FROM NEW.buyer_cache_write_tokens THEN
    RAISE EXCEPTION 'Economic event differs from buyer settlement log'
      USING ERRCODE='23514', CONSTRAINT='shared_key_economic_buyer_mismatch';
  END IF;
  SELECT count(*) INTO expected_count
    FROM cinatoken_economic_quotes.shared_key_dispatch_quote_attempts
    WHERE request_log_id=NEW.request_log_id;
  SELECT count(*),count(*) FILTER (WHERE usage_certainty IN ('estimated','unknown')
      OR provider_cost_certainty IN ('estimated','unknown'))
    INTO actual_count,unresolved_count
    FROM cinatoken_economic_outbox.shared_key_economic_event_attempts
    WHERE event_id=NEW.event_id;
  IF expected_count<1 OR expected_count<>NEW.attempt_count
    OR actual_count<>expected_count
    OR EXISTS (SELECT 1 FROM cinatoken_economic_quotes.shared_key_dispatch_quote_attempts AS a
      LEFT JOIN cinatoken_economic_outbox.shared_key_economic_event_attempts AS o
        ON o.attempt_id=a.attempt_id AND o.event_id=NEW.event_id
      WHERE a.request_log_id=NEW.request_log_id AND o.attempt_id IS NULL) THEN
    RAISE EXCEPTION 'Economic event does not cover every dispatched shared-key attempt'
      USING ERRCODE='23514', CONSTRAINT='shared_key_economic_attempt_coverage';
  END IF;
  IF (unresolved_count=0) IS DISTINCT FROM (NEW.event_certainty='confirmed') THEN
    RAISE EXCEPTION 'Economic event certainty differs from attempt facts'
      USING ERRCODE='23514', CONSTRAINT='shared_key_economic_certainty';
  END IF;
  IF EXISTS (SELECT 1 FROM cinatoken_gateway.shared_key_earnings
      WHERE request_log_id=NEW.request_log_id) THEN
    RAISE EXCEPTION 'Legacy earning and economic event coexist'
      USING ERRCODE='23514', CONSTRAINT='shared_key_economic_legacy_paid';
  END IF;
  RETURN NULL;
END;
$verify$;
CREATE CONSTRAINT TRIGGER shared_key_economic_events_verify
  AFTER INSERT ON cinatoken_economic_outbox.shared_key_economic_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION cinatoken_economic_outbox.verify_economic_event();

CREATE FUNCTION cinatoken_economic_outbox.reject_economic_fact_mutation()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $reject$
BEGIN
  RAISE EXCEPTION 'Shared-key economic event facts are append-only'
    USING ERRCODE='23514', CONSTRAINT='shared_key_economic_append_only';
END;
$reject$;
CREATE TRIGGER shared_key_economic_events_no_change BEFORE UPDATE OR DELETE
  ON cinatoken_economic_outbox.shared_key_economic_events FOR EACH STATEMENT
  EXECUTE FUNCTION cinatoken_economic_outbox.reject_economic_fact_mutation();
CREATE TRIGGER shared_key_economic_events_no_truncate BEFORE TRUNCATE
  ON cinatoken_economic_outbox.shared_key_economic_events FOR EACH STATEMENT
  EXECUTE FUNCTION cinatoken_economic_outbox.reject_economic_fact_mutation();
CREATE TRIGGER shared_key_economic_attempts_no_change BEFORE UPDATE OR DELETE
  ON cinatoken_economic_outbox.shared_key_economic_event_attempts FOR EACH STATEMENT
  EXECUTE FUNCTION cinatoken_economic_outbox.reject_economic_fact_mutation();
CREATE TRIGGER shared_key_economic_attempts_no_truncate BEFORE TRUNCATE
  ON cinatoken_economic_outbox.shared_key_economic_event_attempts FOR EACH STATEMENT
  EXECUTE FUNCTION cinatoken_economic_outbox.reject_economic_fact_mutation();

REVOKE ALL ON ALL TABLES IN SCHEMA cinatoken_economic_outbox
  FROM PUBLIC, cinatoken_gateway_runtime;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA cinatoken_economic_outbox
  FROM PUBLIC, cinatoken_gateway_runtime;

DO $postflight$
DECLARE runtime_oid oid;
DECLARE migrator_oid oid;
BEGIN
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  IF pg_catalog.has_schema_privilege(runtime_oid,'cinatoken_economic_outbox','USAGE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.relnamespace='cinatoken_economic_outbox'::pg_catalog.regnamespace
        AND c.relkind IN ('r','v','m')
        AND EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY[
          'SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']::text[]) AS p(privilege)
          WHERE pg_catalog.has_table_privilege(runtime_oid,c.oid,p.privilege)))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      WHERE p.pronamespace='cinatoken_economic_outbox'::pg_catalog.regnamespace
        AND pg_catalog.has_function_privilege(runtime_oid,p.oid,'EXECUTE'))
    -- Explicit ALTER DEFAULT PRIVILEGES grants to a third role survive a
    -- REVOKE from PUBLIC/runtime. No nonowner may read or write this private
    -- source, or execute its SECURITY DEFINER guards, at installation time.
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n,
        LATERAL pg_catalog.aclexplode(COALESCE(n.nspacl,
          pg_catalog.acldefault('n',n.nspowner))) acl
      WHERE n.oid='cinatoken_economic_outbox'::pg_catalog.regnamespace
        AND (n.nspowner<>migrator_oid OR acl.grantee<>migrator_oid))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c,
        LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,
          pg_catalog.acldefault('r',c.relowner))) acl
      WHERE c.relnamespace='cinatoken_economic_outbox'::pg_catalog.regnamespace
        AND c.relkind IN ('r','p','v','m','f')
        AND (c.relowner<>migrator_oid OR acl.grantee<>migrator_oid))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p,
        LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,
          pg_catalog.acldefault('f',p.proowner))) acl
      WHERE p.pronamespace='cinatoken_economic_outbox'::pg_catalog.regnamespace
        AND (p.proowner<>migrator_oid OR acl.grantee<>migrator_oid)) THEN
    RAISE EXCEPTION 'Economic outbox ACL exceeds reviewed owner-only contract';
  END IF;
END;
$postflight$;
