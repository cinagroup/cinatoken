-- REVIEW ONLY. Apply as the migrator LOGIN after all 73 formal PostgreSQL
-- migrations, shared-key quote versions, dispatch quote attempts and the
-- shared-key economic outbox proposal. The caller owns one activation TX:
--   SET LOCAL cinatoken.shared_key_economic_producer_activation = 'reviewed-v1';
-- No route, consumer, payout or automatic deployment is activated here.
-- This narrow SECURITY DEFINER writes in the EXISTING runtime buyer-log TX;
-- its caller never receives direct SELECT/INSERT on private economic tables.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
LOCK TABLE cinatoken_gateway.schema_migrations IN SHARE MODE;
LOCK TABLE cinatoken_gateway.api_key_request_logs,
  cinatoken_gateway.shared_key_earnings,
  cinatoken_economic_quotes.shared_key_dispatch_quote_attempts,
  cinatoken_economic_outbox.shared_key_economic_events,
  cinatoken_economic_outbox.shared_key_economic_event_attempts
  IN SHARE ROW EXCLUSIVE MODE;

-- Pin the reviewed guard bodies for the rest of this activation transaction.
-- Table locks fence trigger DDL, but do not fence CREATE OR REPLACE FUNCTION.
-- An unchanged COST update takes the pg_proc tuple lock before attestation.
ALTER FUNCTION cinatoken_economic_quotes.reject_dispatch_quote_attempt_mutation() COST 100;
ALTER FUNCTION cinatoken_economic_outbox.guard_event_insert() COST 100;
ALTER FUNCTION cinatoken_economic_outbox.guard_legacy_earning_insert() COST 100;
ALTER FUNCTION cinatoken_economic_outbox.lock_request_economic_enrollment() COST 100;
ALTER FUNCTION cinatoken_economic_outbox.require_event_for_buyer_log() COST 100;
ALTER FUNCTION cinatoken_economic_outbox.verify_economic_event() COST 100;
ALTER FUNCTION cinatoken_economic_outbox.reject_economic_fact_mutation() COST 100;

DO $preflight$
DECLARE migrator_oid oid;
DECLARE runtime_oid oid;
DECLARE protected_functions integer;
DECLARE protected_triggers integer;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  IF pg_catalog.current_setting('cinatoken.shared_key_economic_producer_activation',true)
      IS DISTINCT FROM 'reviewed-v1'
    OR CURRENT_USER <> 'cinatoken_gateway_migrator'
    OR SESSION_USER <> CURRENT_USER
    OR migrator_oid IS NULL OR runtime_oid IS NULL
    OR (SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE oid=migrator_oid) IS DISTINCT FROM TRUE
    OR (SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE oid=runtime_oid) IS DISTINCT FROM TRUE
    OR (SELECT rolsuper FROM pg_catalog.pg_roles WHERE oid=runtime_oid) IS TRUE
    OR pg_catalog.pg_has_role(runtime_oid,migrator_oid,'MEMBER')
    OR pg_catalog.pg_has_role(runtime_oid,'pg_read_all_data'::pg_catalog.regrole,'MEMBER')
    OR pg_catalog.pg_has_role(runtime_oid,'pg_write_all_data'::pg_catalog.regrole,'MEMBER')
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
      '0045_route_data_policy_subject_fingerprint.sql',
      '0046_model_endpoints.sql',
      '0047_model_endpoint_route_subject_fingerprint.sql',
      '0048_model_endpoint_audio_capabilities.sql',
      '0049_model_endpoint_evidence_ledger.sql',
      '0050_management_api_keys.sql', '0051_gateway_key_expiry.sql',
      '0052_gateway_key_limits.sql', '0053_workspace_budgets.sql',
      '0054_generation_metadata_snapshots.sql', '0055_request_session_id.sql',
      '0056_generation_feedback.sql',
      '0057_guardrail_assignment_management_source.sql',
      '0058_workspace_default_guardrails.sql',
      '0059_account_default_guardrails.sql',
      '0060_provider_attempt_availability.sql',
      '0061_public_model_total_tokens.sql',
      '0062_generation_service_tier.sql', '0063_private_byok.sql',
      '0064_byok_always_use_for_provider.sql',
      '0065_guardrail_budget_settlement_basis.sql',
      '0066_workspace_budget_usage_index.sql', '0067_batch_jobs.sql',
      '0068_function_schema_resolution.sql',
      '0069_recovery_dispatch_intents.sql',
      '0070_recovery_settlement_facts.sql', '0071_recovery_jobs.sql',
      '0072_recovery_commit_receipts.sql',
      '0073_recovery_api_key_workspace_lock.sql'
    ]::text[]
    OR pg_catalog.to_regprocedure(
      'cinatoken_economic_outbox.write_shared_key_economic_event(text,text,text,jsonb,text)')
      IS NOT NULL
    OR pg_catalog.to_regclass('cinatoken_economic_outbox.shared_key_economic_producer_tx_markers')
      IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE
      oid='cinatoken_gateway.api_key_request_logs'::pg_catalog.regclass
      AND relowner=migrator_oid AND relkind='r' AND NOT relrowsecurity AND NOT relforcerowsecurity)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE
      oid='cinatoken_economic_quotes.shared_key_dispatch_quote_attempts'::pg_catalog.regclass
      AND relowner=migrator_oid AND relkind='r' AND NOT relrowsecurity AND NOT relforcerowsecurity)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE
      oid='cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass
      AND relowner=migrator_oid AND relkind='r' AND NOT relrowsecurity AND NOT relforcerowsecurity)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE
      oid='cinatoken_economic_outbox.shared_key_economic_event_attempts'::pg_catalog.regclass
      AND relowner=migrator_oid AND relkind='r' AND NOT relrowsecurity AND NOT relforcerowsecurity)
    OR pg_catalog.has_schema_privilege(runtime_oid,'cinatoken_economic_outbox','USAGE')
    OR pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass,'INSERT')
    OR pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_economic_outbox.shared_key_economic_event_attempts'::pg_catalog.regclass,'INSERT')
  THEN
    RAISE EXCEPTION 'Shared-key economic producer activation or dependency differs';
  END IF;
  -- These v339 functions guard truthful claim references, old/new double-pay
  -- exclusion, deferred event coverage and immutable event/outcome replay.
  WITH expected(schema_name,name,body_md5,definer) AS (VALUES
    ('cinatoken_economic_quotes','reject_dispatch_quote_attempt_mutation',
      'd18cbdd94833a0b9cb3f4a013ffb7bb7',false),
    ('cinatoken_economic_outbox','guard_event_insert',
      'ac9a1207b45df0e38a5b3c0dce0eca77',true),
    ('cinatoken_economic_outbox','guard_legacy_earning_insert',
      '41d9eaeee437ffbce83ac06ff7fe3921',true),
    ('cinatoken_economic_outbox','lock_request_economic_enrollment',
      '55e9e7b94e2099548dfbec23425c9fc0',true),
    ('cinatoken_economic_outbox','require_event_for_buyer_log',
      'dedde60c7696048bdedb9c2459aa83a7',true),
    ('cinatoken_economic_outbox','verify_economic_event',
      '6f9368aa5d93c4af204d9aad5dda3e77',true),
    ('cinatoken_economic_outbox','reject_economic_fact_mutation',
      'fb4bf3ef2ba3a1a8adbe03877e299b33',true)
  )
  SELECT pg_catalog.count(*) INTO protected_functions FROM expected AS e
    JOIN pg_catalog.pg_namespace AS n ON n.nspname=e.schema_name
    JOIN pg_catalog.pg_proc AS p ON p.pronamespace=n.oid AND p.proname=e.name
    JOIN pg_catalog.pg_language AS l ON l.oid=p.prolang
    WHERE p.pronargs=0 AND p.prorettype='pg_catalog.trigger'::pg_catalog.regtype
      AND p.proowner=migrator_oid AND l.lanname='plpgsql'
      AND p.provolatile='v' AND p.prosecdef=e.definer
      AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[]
      AND p.procost=100 AND pg_catalog.md5(p.prosrc)=e.body_md5;
  IF protected_functions<>7 THEN
    RAISE EXCEPTION 'Reviewed shared-key economic producer function catalog differs';
  END IF;
  WITH expected(name,schema_name,relation_name,function_schema,function_name,kind,deferred) AS (VALUES
    ('shared_quote_attempts_no_change','cinatoken_economic_quotes',
      'shared_key_dispatch_quote_attempts','cinatoken_economic_quotes',
      'reject_dispatch_quote_attempt_mutation',26,false),
    ('shared_quote_attempts_no_truncate','cinatoken_economic_quotes',
      'shared_key_dispatch_quote_attempts','cinatoken_economic_quotes',
      'reject_dispatch_quote_attempt_mutation',34,false),
    ('shared_key_economic_events_guard_insert','cinatoken_economic_outbox',
      'shared_key_economic_events','cinatoken_economic_outbox','guard_event_insert',7,false),
    ('shared_key_earnings_reject_economic_event','cinatoken_gateway',
      'shared_key_earnings','cinatoken_economic_outbox','guard_legacy_earning_insert',7,false),
    ('api_key_request_logs_lock_shared_quote_attempts','cinatoken_gateway',
      'api_key_request_logs','cinatoken_economic_outbox','lock_request_economic_enrollment',7,false),
    ('api_key_request_logs_require_shared_key_economic_event','cinatoken_gateway',
      'api_key_request_logs','cinatoken_economic_outbox','require_event_for_buyer_log',5,true),
    ('shared_key_economic_events_verify','cinatoken_economic_outbox',
      'shared_key_economic_events','cinatoken_economic_outbox','verify_economic_event',5,true),
    ('shared_key_economic_events_no_change','cinatoken_economic_outbox',
      'shared_key_economic_events','cinatoken_economic_outbox','reject_economic_fact_mutation',26,false),
    ('shared_key_economic_events_no_truncate','cinatoken_economic_outbox',
      'shared_key_economic_events','cinatoken_economic_outbox','reject_economic_fact_mutation',34,false),
    ('shared_key_economic_attempts_no_change','cinatoken_economic_outbox',
      'shared_key_economic_event_attempts','cinatoken_economic_outbox',
      'reject_economic_fact_mutation',26,false),
    ('shared_key_economic_attempts_no_truncate','cinatoken_economic_outbox',
      'shared_key_economic_event_attempts','cinatoken_economic_outbox',
      'reject_economic_fact_mutation',34,false)
  )
  SELECT pg_catalog.count(*) INTO protected_triggers FROM expected AS e
    JOIN pg_catalog.pg_namespace AS n ON n.nspname=e.schema_name
    JOIN pg_catalog.pg_class AS c ON c.relnamespace=n.oid AND c.relname=e.relation_name
    JOIN pg_catalog.pg_trigger AS t ON t.tgrelid=c.oid AND t.tgname=e.name
    JOIN pg_catalog.pg_proc AS p ON p.oid=t.tgfoid AND p.proname=e.function_name
    JOIN pg_catalog.pg_namespace AS pn ON pn.oid=p.pronamespace
    WHERE pn.nspname=e.function_schema AND p.pronargs=0
      AND t.tgenabled='O' AND NOT t.tgisinternal
      AND t.tgtype=e.kind AND t.tgdeferrable=e.deferred
      AND t.tginitdeferred=e.deferred AND t.tgqual IS NULL
      AND t.tgnargs=0 AND pg_catalog.octet_length(t.tgargs)=0
      AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL;
  IF protected_triggers<>11 OR
    (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger
      WHERE tgrelid IN (
        'cinatoken_economic_quotes.shared_key_dispatch_quote_attempts'::pg_catalog.regclass,
        'cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass,
        'cinatoken_economic_outbox.shared_key_economic_event_attempts'::pg_catalog.regclass)
        AND NOT tgisinternal)<>8 THEN
    RAISE EXCEPTION 'Reviewed shared-key economic producer trigger catalog differs';
  END IF;
END;
$preflight$;

-- The marker is inserted by a trusted AFTER INSERT trigger only when a quote
-- attempt already exists. It records the complete xid8 of THAT buyer-log TX.
-- A runtime caller may verify a committed event later, but cannot create an
-- event retrospectively for a previously committed buyer log.
CREATE TABLE cinatoken_economic_outbox.shared_key_economic_producer_tx_markers (
  request_log_id text PRIMARY KEY REFERENCES cinatoken_gateway.api_key_request_logs(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  log_xact_id xid8 NOT NULL,
  CONSTRAINT shared_key_economic_marker_event FOREIGN KEY (request_log_id)
    REFERENCES cinatoken_economic_outbox.shared_key_economic_events(request_log_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);

CREATE FUNCTION cinatoken_economic_outbox.mark_shared_key_buyer_log_tx()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $mark$
BEGIN
  IF TG_RELID<>'cinatoken_gateway.api_key_request_logs'::pg_catalog.regclass
    OR TG_NAME<>'api_key_request_logs_mark_shared_key_economic_tx'
    OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW' THEN
    RAISE EXCEPTION 'Economic producer marker trigger binding differs';
  END IF;
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Economic producer requires READ COMMITTED'
      USING ERRCODE='23514', CONSTRAINT='shared_key_economic_producer_isolation';
  END IF;
  IF EXISTS (SELECT 1 FROM cinatoken_economic_quotes.shared_key_dispatch_quote_attempts
      WHERE request_log_id=NEW.id) THEN
    INSERT INTO cinatoken_economic_outbox.shared_key_economic_producer_tx_markers
      (request_log_id,log_xact_id)
      VALUES (NEW.id,pg_catalog.pg_current_xact_id());
  END IF;
  RETURN NULL;
END;
$mark$;
CREATE TRIGGER api_key_request_logs_mark_shared_key_economic_tx
  AFTER INSERT ON cinatoken_gateway.api_key_request_logs FOR EACH ROW
  EXECUTE FUNCTION cinatoken_economic_outbox.mark_shared_key_buyer_log_tx();

CREATE FUNCTION cinatoken_economic_outbox.write_shared_key_economic_event(
  p_request_log_id text, p_buyer_charge_basis text,
  p_buyer_usage_certainty text, p_outcomes jsonb, p_mode text)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $producer$
DECLARE buyer record;
DECLARE stored record;
DECLARE item jsonb;
DECLARE outcome_count integer;
DECLARE unresolved_count integer := 0;
DECLARE claimed_count integer;
DECLARE seen_ids uuid[] := ARRAY[]::uuid[];
DECLARE seen_indices integer[] := ARRAY[]::integer[];
DECLARE a_id uuid;
DECLARE a_index integer;
DECLARE a_shared_key text;
DECLARE a_transition text;
DECLARE a_quote text;
DECLARE a_usage text;
DECLARE a_input bigint;
DECLARE a_output bigint;
DECLARE a_cache_read bigint;
DECLARE a_cache_write bigint;
DECLARE a_cost_certainty text;
DECLARE a_cost bigint;
DECLARE a_evidence text;
DECLARE a_sha text;
DECLARE a_observed timestamptz;
DECLARE expected_keys text[] := ARRAY[
  'attempt_id','attempt_index','cache_read_tokens','cache_write_tokens',
  'evidence_kind','evidence_sha256','input_tokens','observed_at',
  'output_tokens','provider_cost_certainty','provider_cost_micros',
  'quote_version_id','shared_key_id','transition_id','usage_certainty']::text[];
BEGIN
  IF CURRENT_USER <> 'cinatoken_gateway_migrator'
    OR SESSION_USER <> 'cinatoken_gateway_runtime' THEN
    RAISE EXCEPTION 'Dedicated runtime LOGIN required for economic producer'
      USING ERRCODE='42501';
  END IF;
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Economic producer requires READ COMMITTED'
      USING ERRCODE='23514', CONSTRAINT='shared_key_economic_producer_isolation';
  END IF;
  IF p_request_log_id IS NULL OR pg_catalog.length(p_request_log_id) NOT BETWEEN 1 AND 128
    OR p_request_log_id <> pg_catalog.btrim(p_request_log_id)
    OR p_mode NOT IN ('create','verify')
    OR p_buyer_charge_basis NOT IN ('actual','reserved','none')
    OR p_buyer_usage_certainty NOT IN ('actual','unknown')
    OR (p_buyer_charge_basis='actual' AND p_buyer_usage_certainty<>'actual')
    -- The v339 event copies the log's Guardrail charge, which cannot express
    -- an ordinary-user reserved ceiling debit. Reject every reserved path,
    -- including a ceiling numerically equal to the current log charge.
    OR p_buyer_charge_basis='reserved'
    OR pg_catalog.jsonb_typeof(p_outcomes) <> 'array'
    OR pg_catalog.jsonb_array_length(p_outcomes) NOT BETWEEN 1 AND 1000
    OR pg_catalog.octet_length(p_outcomes::text) > 4194304
    OR p_mode IS NULL OR p_buyer_charge_basis IS NULL
    OR p_buyer_usage_certainty IS NULL OR p_outcomes IS NULL THEN
    RAISE EXCEPTION 'Invalid shared-key economic producer input'
      USING ERRCODE='23514', CONSTRAINT='shared_key_economic_producer_input';
  END IF;
  outcome_count := pg_catalog.jsonb_array_length(p_outcomes);

  SELECT l.id,l.user_id,l.api_key_id,l.workspace_id,l.charged_cost,
    l.budget_charged_micros,l.input_tokens,l.output_tokens,
    l.cache_read_tokens,l.cache_write_tokens
    INTO buyer FROM cinatoken_gateway.api_key_request_logs AS l
    WHERE l.id=p_request_log_id FOR UPDATE;
  IF NOT FOUND OR buyer.user_id IS NULL OR buyer.workspace_id IS NULL
    OR (p_buyer_charge_basis='none'
      AND (buyer.budget_charged_micros<>0 OR buyer.charged_cost<>0
        OR EXISTS (SELECT 1 FROM cinatoken_gateway.user_budget_reservations
          WHERE request_id=p_request_log_id)))
    OR (p_buyer_charge_basis='actual'
      AND ((buyer.charged_cost>0 AND buyer.budget_charged_micros=0)
        OR EXISTS (SELECT 1 FROM cinatoken_gateway.user_budget_reservations
          WHERE request_id=p_request_log_id
            AND (state<>'settled'
              OR settled_micros<>buyer.budget_charged_micros)))) THEN
    RAISE EXCEPTION 'Economic producer buyer log or basis differs'
      USING ERRCODE='23514', CONSTRAINT='shared_key_economic_producer_buyer';
  END IF;
  SELECT count(*) INTO claimed_count
    FROM cinatoken_economic_quotes.shared_key_dispatch_quote_attempts
    WHERE request_log_id=p_request_log_id;
  IF claimed_count<>outcome_count THEN
    RAISE EXCEPTION 'Economic producer does not cover every quote attempt'
      USING ERRCODE='23514', CONSTRAINT='shared_key_economic_producer_coverage';
  END IF;

  -- Reject extras and JSON strings masquerading as numeric facts before cast.
  -- SQL table constraints then validate certainty, zero and evidence shapes.
  FOR item IN SELECT value FROM pg_catalog.jsonb_array_elements(p_outcomes) AS e(value)
  LOOP
    IF pg_catalog.jsonb_typeof(item)<>'object'
      OR ARRAY(SELECT key FROM pg_catalog.jsonb_object_keys(item) AS k(key)
        ORDER BY key COLLATE "C") IS DISTINCT FROM expected_keys
      OR pg_catalog.jsonb_typeof(item->'attempt_id')<>'string'
      OR pg_catalog.jsonb_typeof(item->'attempt_index')<>'number'
      OR pg_catalog.jsonb_typeof(item->'shared_key_id')<>'string'
      OR pg_catalog.jsonb_typeof(item->'transition_id')<>'string'
      OR pg_catalog.jsonb_typeof(item->'quote_version_id')<>'string'
      OR pg_catalog.jsonb_typeof(item->'usage_certainty')<>'string'
      OR pg_catalog.jsonb_typeof(item->'provider_cost_certainty')<>'string'
      OR pg_catalog.jsonb_typeof(item->'evidence_kind')<>'string'
      OR pg_catalog.jsonb_typeof(item->'observed_at')<>'string'
      OR pg_catalog.jsonb_typeof(item->'evidence_sha256') NOT IN ('string','null')
      OR pg_catalog.jsonb_typeof(item->'input_tokens') NOT IN ('number','null')
      OR pg_catalog.jsonb_typeof(item->'output_tokens') NOT IN ('number','null')
      OR pg_catalog.jsonb_typeof(item->'cache_read_tokens') NOT IN ('number','null')
      OR pg_catalog.jsonb_typeof(item->'cache_write_tokens') NOT IN ('number','null')
      OR pg_catalog.jsonb_typeof(item->'provider_cost_micros') NOT IN ('number','null')
      OR (item->>'attempt_id') COLLATE "C" !~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR (item->>'observed_at') COLLATE "C" !~
        '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
      OR (item->>'attempt_index')::numeric NOT BETWEEN 1 AND 1000
      OR pg_catalog.mod((item->>'attempt_index')::numeric,1)<>0 THEN
      RAISE EXCEPTION 'Invalid shared-key economic outcome JSON shape'
        USING ERRCODE='23514', CONSTRAINT='shared_key_economic_producer_outcome_shape';
    END IF;
    FOREACH a_evidence IN ARRAY ARRAY['input_tokens','output_tokens',
      'cache_read_tokens','cache_write_tokens','provider_cost_micros'] LOOP
      IF item->>a_evidence IS NOT NULL
        AND ((item->>a_evidence)::numeric NOT BETWEEN 0 AND 9007199254740991
          OR pg_catalog.mod((item->>a_evidence)::numeric,1)<>0) THEN
        RAISE EXCEPTION 'Unsafe shared-key economic numeric outcome'
          USING ERRCODE='23514', CONSTRAINT='shared_key_economic_producer_outcome_number';
      END IF;
    END LOOP;
    a_id := (item->>'attempt_id')::uuid;
    a_index := (item->>'attempt_index')::integer;
    a_shared_key := item->>'shared_key_id';
    a_transition := item->>'transition_id';
    a_quote := item->>'quote_version_id';
    a_usage := item->>'usage_certainty';
    a_input := (item->>'input_tokens')::bigint;
    a_output := (item->>'output_tokens')::bigint;
    a_cache_read := (item->>'cache_read_tokens')::bigint;
    a_cache_write := (item->>'cache_write_tokens')::bigint;
    a_cost_certainty := item->>'provider_cost_certainty';
    a_cost := (item->>'provider_cost_micros')::bigint;
    a_evidence := item->>'evidence_kind';
    a_sha := item->>'evidence_sha256';
    a_observed := (item->>'observed_at')::timestamptz;
    IF a_id=ANY(seen_ids) OR a_index=ANY(seen_indices)
      OR a_shared_key IS NULL OR a_transition IS NULL OR a_quote IS NULL
      OR a_usage IS NULL OR a_cost_certainty IS NULL OR a_evidence IS NULL
      OR pg_catalog.length(a_shared_key) NOT BETWEEN 1 AND 512
      OR pg_catalog.length(a_transition) NOT BETWEEN 1 AND 512
      OR pg_catalog.length(a_quote) NOT BETWEEN 1 AND 512
      OR a_shared_key<>pg_catalog.btrim(a_shared_key)
      OR a_transition<>pg_catalog.btrim(a_transition)
      OR a_quote<>pg_catalog.btrim(a_quote)
      OR NOT EXISTS (SELECT 1 FROM
          cinatoken_economic_quotes.shared_key_dispatch_quote_attempts AS q
        WHERE q.attempt_id=a_id AND q.request_log_id=p_request_log_id
          AND q.attempt_index=a_index AND q.shared_key_id=a_shared_key
          AND q.transition_id=a_transition AND q.quote_version_id=a_quote) THEN
      RAISE EXCEPTION 'Economic outcome quote identity or uniqueness differs'
        USING ERRCODE='23514', CONSTRAINT='shared_key_economic_producer_attempt';
    END IF;
    seen_ids:=pg_catalog.array_append(seen_ids,a_id);
    seen_indices:=pg_catalog.array_append(seen_indices,a_index);
    IF a_usage IN ('estimated','unknown') OR a_cost_certainty IN ('estimated','unknown') THEN
      unresolved_count:=unresolved_count+1;
    END IF;

    IF p_mode='verify' THEN
      IF NOT EXISTS (SELECT 1 FROM
          cinatoken_economic_outbox.shared_key_economic_event_attempts AS o
        WHERE o.event_id=p_request_log_id AND o.request_log_id=p_request_log_id
          AND o.attempt_id=a_id AND o.attempt_index=a_index
          AND o.shared_key_id=a_shared_key AND o.transition_id=a_transition
          AND o.quote_version_id=a_quote AND o.usage_certainty=a_usage
          AND o.input_tokens IS NOT DISTINCT FROM a_input
          AND o.output_tokens IS NOT DISTINCT FROM a_output
          AND o.cache_read_tokens IS NOT DISTINCT FROM a_cache_read
          AND o.cache_write_tokens IS NOT DISTINCT FROM a_cache_write
          AND o.provider_cost_certainty=a_cost_certainty
          AND o.provider_cost_micros IS NOT DISTINCT FROM a_cost
          AND o.evidence_kind=a_evidence
          AND o.evidence_sha256 IS NOT DISTINCT FROM a_sha
          AND o.observed_at=a_observed) THEN
        RAISE EXCEPTION 'Conflicting economic outcome replay'
          USING ERRCODE='23514', CONSTRAINT='shared_key_economic_producer_replay';
      END IF;
    END IF;
  END LOOP;

  IF p_mode='verify' THEN
    SELECT e.buyer_charge_basis,e.buyer_usage_certainty,e.buyer_user_id,
      e.buyer_api_key_id,e.workspace_id,e.buyer_charged_cost,
      e.buyer_budget_charged_micros,e.buyer_input_tokens,e.buyer_output_tokens,
      e.buyer_cache_read_tokens,e.buyer_cache_write_tokens,
      e.attempt_count,e.event_certainty INTO stored
      FROM cinatoken_economic_outbox.shared_key_economic_events AS e
      WHERE e.request_log_id=p_request_log_id;
    IF NOT FOUND OR stored.buyer_charge_basis IS DISTINCT FROM p_buyer_charge_basis
      OR stored.buyer_usage_certainty IS DISTINCT FROM p_buyer_usage_certainty
      OR stored.buyer_user_id IS DISTINCT FROM buyer.user_id
      OR stored.buyer_api_key_id IS DISTINCT FROM buyer.api_key_id
      OR stored.workspace_id IS DISTINCT FROM buyer.workspace_id
      OR stored.buyer_charged_cost IS DISTINCT FROM buyer.charged_cost
      OR stored.buyer_budget_charged_micros IS DISTINCT FROM buyer.budget_charged_micros
      OR stored.buyer_input_tokens IS DISTINCT FROM buyer.input_tokens
      OR stored.buyer_output_tokens IS DISTINCT FROM buyer.output_tokens
      OR stored.buyer_cache_read_tokens IS DISTINCT FROM buyer.cache_read_tokens
      OR stored.buyer_cache_write_tokens IS DISTINCT FROM buyer.cache_write_tokens
      OR stored.attempt_count IS DISTINCT FROM outcome_count
      OR stored.event_certainty IS DISTINCT FROM
        (CASE WHEN unresolved_count=0 THEN 'confirmed' ELSE 'unresolved' END) THEN
      RAISE EXCEPTION 'Conflicting economic event replay'
        USING ERRCODE='23514', CONSTRAINT='shared_key_economic_producer_replay';
    END IF;
    RETURN 'verified';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM
      cinatoken_economic_outbox.shared_key_economic_producer_tx_markers AS m
    WHERE m.request_log_id=p_request_log_id
      AND m.log_xact_id=pg_catalog.pg_current_xact_id())
    OR EXISTS (SELECT 1 FROM cinatoken_economic_outbox.shared_key_economic_events
      WHERE request_log_id=p_request_log_id) THEN
    RAISE EXCEPTION 'Economic event creation requires this buyer-log transaction'
      USING ERRCODE='23514', CONSTRAINT='shared_key_economic_producer_tx';
  END IF;
  INSERT INTO cinatoken_economic_outbox.shared_key_economic_events
    (event_id,request_log_id,event_type,event_version,buyer_user_id,
      buyer_api_key_id,workspace_id,buyer_charge_basis,buyer_usage_certainty,
      buyer_charged_cost,buyer_budget_charged_micros,buyer_input_tokens,
      buyer_output_tokens,buyer_cache_read_tokens,buyer_cache_write_tokens,
      attempt_count,event_certainty)
    VALUES (p_request_log_id,p_request_log_id,'shared_key_usage_settled',1,
      buyer.user_id,buyer.api_key_id,buyer.workspace_id,p_buyer_charge_basis,
      p_buyer_usage_certainty,buyer.charged_cost,buyer.budget_charged_micros,
      buyer.input_tokens,buyer.output_tokens,buyer.cache_read_tokens,
      buyer.cache_write_tokens,outcome_count,
      CASE WHEN unresolved_count=0 THEN 'confirmed' ELSE 'unresolved' END);
  FOR item IN SELECT value FROM pg_catalog.jsonb_array_elements(p_outcomes) AS e(value)
  LOOP
    INSERT INTO cinatoken_economic_outbox.shared_key_economic_event_attempts
      (event_id,request_log_id,attempt_id,attempt_index,shared_key_id,
        transition_id,quote_version_id,usage_certainty,input_tokens,output_tokens,
        cache_read_tokens,cache_write_tokens,provider_cost_certainty,
        provider_cost_micros,evidence_kind,evidence_sha256,observed_at)
      VALUES (p_request_log_id,p_request_log_id,(item->>'attempt_id')::uuid,
        (item->>'attempt_index')::integer,item->>'shared_key_id',
        item->>'transition_id',item->>'quote_version_id',
        item->>'usage_certainty',(item->>'input_tokens')::bigint,
        (item->>'output_tokens')::bigint,(item->>'cache_read_tokens')::bigint,
        (item->>'cache_write_tokens')::bigint,item->>'provider_cost_certainty',
        (item->>'provider_cost_micros')::bigint,item->>'evidence_kind',
        item->>'evidence_sha256',(item->>'observed_at')::timestamptz);
  END LOOP;
  RETURN 'inserted';
END;
$producer$;

REVOKE ALL ON TABLE cinatoken_economic_outbox.shared_key_economic_producer_tx_markers
  FROM PUBLIC,cinatoken_gateway_runtime;
REVOKE ALL ON FUNCTION cinatoken_economic_outbox.mark_shared_key_buyer_log_tx()
  FROM PUBLIC,cinatoken_gateway_runtime;
REVOKE ALL ON FUNCTION cinatoken_economic_outbox.write_shared_key_economic_event(
  text,text,text,jsonb,text) FROM PUBLIC,cinatoken_gateway_runtime;
GRANT USAGE ON SCHEMA cinatoken_economic_outbox TO cinatoken_gateway_runtime;
GRANT EXECUTE ON FUNCTION cinatoken_economic_outbox.write_shared_key_economic_event(
  text,text,text,jsonb,text) TO cinatoken_gateway_runtime;

DO $postflight$
DECLARE migrator_oid oid;
DECLARE runtime_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  IF NOT pg_catalog.has_schema_privilege(runtime_oid,'cinatoken_economic_outbox','USAGE')
    OR NOT pg_catalog.has_function_privilege(runtime_oid,
      'cinatoken_economic_outbox.write_shared_key_economic_event(text,text,text,jsonb,text)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,
      'cinatoken_economic_outbox.mark_shared_key_buyer_log_tx()','EXECUTE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE
      c.relnamespace='cinatoken_economic_outbox'::pg_catalog.regnamespace
      AND c.relkind IN ('r','p','v','m','f')
      AND (c.relowner<>migrator_oid OR c.relrowsecurity OR c.relforcerowsecurity
        OR pg_catalog.has_table_privilege(runtime_oid,c.oid,'SELECT')
        OR pg_catalog.has_table_privilege(runtime_oid,c.oid,'INSERT')
        OR pg_catalog.has_table_privilege(runtime_oid,c.oid,'UPDATE')
        OR pg_catalog.has_table_privilege(runtime_oid,c.oid,'DELETE')))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n,
        LATERAL pg_catalog.aclexplode(COALESCE(n.nspacl,
          pg_catalog.acldefault('n',n.nspowner))) acl
      WHERE n.oid='cinatoken_economic_outbox'::pg_catalog.regnamespace
        AND (acl.grantee NOT IN (migrator_oid,runtime_oid)
          OR (acl.grantee=runtime_oid AND
            (acl.privilege_type<>'USAGE' OR acl.is_grantable))))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c,
        LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,
          pg_catalog.acldefault('r',c.relowner))) acl
      WHERE c.relnamespace='cinatoken_economic_outbox'::pg_catalog.regnamespace
        AND c.relkind IN ('r','p','v','m','f') AND acl.grantee<>migrator_oid)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p,
        LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,
          pg_catalog.acldefault('f',p.proowner))) acl
      WHERE p.pronamespace='cinatoken_economic_outbox'::pg_catalog.regnamespace
        AND (p.proowner<>migrator_oid
          OR (acl.grantee<>migrator_oid AND NOT
            (p.oid='cinatoken_economic_outbox.write_shared_key_economic_event(text,text,text,jsonb,text)'::pg_catalog.regprocedure
              AND acl.grantee=runtime_oid AND acl.privilege_type='EXECUTE'
              AND NOT acl.is_grantable))))
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE
      p.oid='cinatoken_economic_outbox.write_shared_key_economic_event(text,text,text,jsonb,text)'::pg_catalog.regprocedure
      AND p.proowner=migrator_oid AND p.prosecdef AND p.provolatile='v'
      AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[])
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE
      t.tgrelid='cinatoken_gateway.api_key_request_logs'::pg_catalog.regclass
      AND t.tgname='api_key_request_logs_mark_shared_key_economic_tx'
      AND t.tgfoid='cinatoken_economic_outbox.mark_shared_key_buyer_log_tx()'::pg_catalog.regprocedure
      AND t.tgenabled='O' AND t.tgqual IS NULL AND NOT t.tgisinternal)
  THEN
    RAISE EXCEPTION 'Shared-key economic producer ACL or binding exceeds reviewed contract';
  END IF;
END;
$postflight$;
