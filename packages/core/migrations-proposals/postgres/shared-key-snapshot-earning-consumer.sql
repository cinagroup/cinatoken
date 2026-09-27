-- REVIEW ONLY. PostgreSQL snapshot-based, event-keyed seller earning consumer.
-- Install after formal PG73, shared-key-quote-versions.sql (v338),
-- shared-key-dispatch-quote-attempts.sql (v339), and
-- shared-key-economic-outbox.sql (v339), in one migrator transaction with:
--   SET LOCAL cinatoken.shared_key_snapshot_consumer_activation = 'reviewed-v1';
-- A separate LOGIN cinatoken_gateway_shared_earning_consumer must already exist.
-- No worker, queue, payout, runtime grant, or production activation is supplied.
-- Only a committed immutable economic event is consumable. Confirmed per-attempt
-- usage AND confirmed upstream cost, together with an actual buyer charge basis,
-- are required for a seller balance credit. Unknown/estimated/no-buyer-actual
-- facts create a durable pending_manual decision with no balance credit. Future
-- actuals must use a separately reviewed adjustment event, never mutate v1 facts.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
LOCK TABLE cinatoken_gateway.schema_migrations,
  cinatoken_gateway.api_key_request_logs,
  cinatoken_gateway.shared_key_earnings,
  cinatoken_gateway.user_earnings,
  cinatoken_gateway.portal_ledger_entries,
  cinatoken_economic_quotes.shared_key_quote_versions,
  cinatoken_economic_quotes.shared_key_dispatch_quote_attempts,
  cinatoken_economic_outbox.shared_key_economic_events,
  cinatoken_economic_outbox.shared_key_economic_event_attempts
  IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid;
DECLARE runtime_oid oid;
DECLARE consumer_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  SELECT oid INTO consumer_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_shared_earning_consumer';
  IF pg_catalog.current_setting('cinatoken.shared_key_snapshot_consumer_activation',true)
      IS DISTINCT FROM 'reviewed-v1'
    OR CURRENT_USER<>'cinatoken_gateway_migrator' OR SESSION_USER<>CURRENT_USER
    OR migrator_oid IS NULL OR runtime_oid IS NULL OR consumer_oid IS NULL
    OR (SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE oid=consumer_oid)
      IS DISTINCT FROM TRUE
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE oid=consumer_oid
      AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls))
    OR pg_catalog.pg_has_role(consumer_oid,migrator_oid,'MEMBER')
    OR pg_catalog.pg_has_role(consumer_oid,runtime_oid,'MEMBER')
    OR pg_catalog.pg_has_role(consumer_oid,'pg_read_all_data'::pg_catalog.regrole,'MEMBER')
    OR pg_catalog.pg_has_role(consumer_oid,'pg_write_all_data'::pg_catalog.regrole,'MEMBER')
    -- A default WITH GRANT OPTION cannot be inherited by the narrowly
    -- delegated consumer or a surprise third role during object creation.
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_default_acl d,
        LATERAL pg_catalog.aclexplode(d.defaclacl) acl
      WHERE d.defaclrole=migrator_oid AND d.defaclnamespace=0
        AND d.defaclobjtype IN ('n','f','r')
        AND acl.grantee<>migrator_oid AND acl.is_grantable)
    OR pg_catalog.to_regnamespace('cinatoken_economic_consumer') IS NOT NULL
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
    RAISE EXCEPTION 'Snapshot earning consumer activation or migration ledger differs';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid IN (
      'cinatoken_gateway.api_key_request_logs'::pg_catalog.regclass,
      'cinatoken_gateway.shared_key_earnings'::pg_catalog.regclass,
      'cinatoken_gateway.user_earnings'::pg_catalog.regclass,
      'cinatoken_gateway.portal_ledger_entries'::pg_catalog.regclass,
      'cinatoken_economic_quotes.shared_key_quote_versions'::pg_catalog.regclass,
      'cinatoken_economic_quotes.shared_key_dispatch_quote_attempts'::pg_catalog.regclass,
      'cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass,
      'cinatoken_economic_outbox.shared_key_economic_event_attempts'::pg_catalog.regclass)
      AND (c.relowner<>migrator_oid OR c.relkind<>'r'
        OR c.relrowsecurity OR c.relforcerowsecurity))
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_class c WHERE c.oid IN (
      'cinatoken_gateway.api_key_request_logs'::pg_catalog.regclass,
      'cinatoken_gateway.shared_key_earnings'::pg_catalog.regclass,
      'cinatoken_gateway.user_earnings'::pg_catalog.regclass,
      'cinatoken_gateway.portal_ledger_entries'::pg_catalog.regclass,
      'cinatoken_economic_quotes.shared_key_quote_versions'::pg_catalog.regclass,
      'cinatoken_economic_quotes.shared_key_dispatch_quote_attempts'::pg_catalog.regclass,
      'cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass,
      'cinatoken_economic_outbox.shared_key_economic_event_attempts'::pg_catalog.regclass))<>8
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
      WHERE tgrelid='cinatoken_gateway.shared_key_earnings'::pg_catalog.regclass
        AND tgname='shared_key_earnings_reject_economic_event' AND tgenabled='O'
        AND tgfoid='cinatoken_economic_outbox.guard_legacy_earning_insert()'::pg_catalog.regprocedure)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
      WHERE tgrelid='cinatoken_gateway.shared_key_earnings'::pg_catalog.regclass
        AND tgname='shared_key_earnings_credit_after_insert' AND tgenabled='O'
        AND tgfoid='cinatoken_gateway.shared_key_earnings_credit_after_insert_fn()'::pg_catalog.regprocedure)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
      WHERE tgrelid='cinatoken_economic_quotes.shared_key_quote_versions'::pg_catalog.regclass
        AND tgname='shared_key_quote_versions_no_change' AND tgenabled='O')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
      WHERE tgrelid='cinatoken_economic_quotes.shared_key_dispatch_quote_attempts'::pg_catalog.regclass
        AND tgname='shared_quote_attempts_no_change' AND tgenabled='O')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
      WHERE tgrelid='cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass
        AND tgname='shared_key_economic_events_no_change' AND tgenabled='O')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
      WHERE tgrelid='cinatoken_economic_outbox.shared_key_economic_event_attempts'::pg_catalog.regclass
        AND tgname='shared_key_economic_attempts_no_change' AND tgenabled='O')
  THEN
    RAISE EXCEPTION 'Snapshot earning consumer source ownership or guard differs';
  END IF;
END;
$preflight$;

CREATE SCHEMA cinatoken_economic_consumer AUTHORIZATION cinatoken_gateway_migrator;
REVOKE ALL ON SCHEMA cinatoken_economic_consumer FROM PUBLIC,cinatoken_gateway_runtime,
  cinatoken_gateway_shared_earning_consumer;

-- A decision exists for every attempt of an event, including pending ones.
-- The event and attempt form the stable idempotency identity. A pending row is
-- deliberately terminal for this v1 event; it may only be resolved by a new
-- reviewed adjustment event after C05 defines that contract.
CREATE TABLE cinatoken_economic_consumer.shared_key_attempt_consumptions (
  event_id text NOT NULL,
  attempt_id uuid NOT NULL,
  request_log_id text NOT NULL,
  attempt_index integer NOT NULL,
  shared_key_id text NOT NULL,
  transition_id text NOT NULL,
  quote_version_id text NOT NULL REFERENCES
    cinatoken_economic_quotes.shared_key_quote_versions(version_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  seller_user_id text NOT NULL REFERENCES cinatoken_gateway.users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision IN ('credited','pending_manual')),
  pending_reason text CHECK (pending_reason IN
    ('buyer_not_actual','attempt_unresolved','evidence_not_settleable')),
  usage_certainty text NOT NULL,
  provider_cost_certainty text NOT NULL,
  provider_cost_micros bigint,
  input_tokens bigint,
  output_tokens bigint,
  cache_read_tokens bigint,
  cache_write_tokens bigint,
  input_price_per_million numeric(18,6) NOT NULL,
  output_price_per_million numeric(18,6) NOT NULL,
  cache_read_price_per_million numeric(18,6) NOT NULL,
  cache_write_price_per_million numeric(18,6) NOT NULL,
  commission_rate numeric(8,6) NOT NULL,
  currency text NOT NULL CHECK (currency='USD'),
  price_unit text NOT NULL CHECK (price_unit='per_million_tokens'),
  gross_micros bigint,
  platform_fee_micros bigint,
  net_micros bigint,
  processed_at timestamptz NOT NULL,
  PRIMARY KEY (event_id,attempt_id),
  UNIQUE (attempt_id),
  UNIQUE (event_id,attempt_index),
  CONSTRAINT shared_key_attempt_consumption_source FOREIGN KEY (event_id,attempt_id)
    REFERENCES cinatoken_economic_outbox.shared_key_economic_event_attempts(event_id,attempt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT shared_key_attempt_consumption_decision CHECK (
    (decision='pending_manual' AND pending_reason IS NOT NULL
      AND gross_micros IS NULL AND platform_fee_micros IS NULL AND net_micros IS NULL)
    OR (decision='credited' AND pending_reason IS NULL
      AND usage_certainty IN ('actual','confirmed_zero')
      AND provider_cost_certainty IN ('actual','confirmed_zero')
      AND gross_micros BETWEEN 0 AND 9007199254740991
      AND platform_fee_micros BETWEEN 0 AND gross_micros
      AND net_micros=gross_micros-platform_fee_micros))
);

CREATE TABLE cinatoken_economic_consumer.shared_key_event_consumptions (
  event_id text PRIMARY KEY REFERENCES
    cinatoken_economic_outbox.shared_key_economic_events(event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision IN ('credited','pending_manual')),
  attempt_count integer NOT NULL CHECK (attempt_count BETWEEN 1 AND 1000),
  credited_attempts integer NOT NULL CHECK (credited_attempts>=0),
  pending_attempts integer NOT NULL CHECK (pending_attempts>=0),
  total_net_micros bigint NOT NULL CHECK
    (total_net_micros BETWEEN 0 AND 9007199254740991),
  processed_at timestamptz NOT NULL,
  CONSTRAINT shared_key_event_consumption_counts CHECK
    (attempt_count=credited_attempts+pending_attempts
      AND (decision='credited')=(pending_attempts=0))
);
CREATE INDEX shared_key_event_consumptions_pending
  ON cinatoken_economic_consumer.shared_key_event_consumptions(processed_at,event_id)
  WHERE decision='pending_manual';

CREATE FUNCTION cinatoken_economic_consumer.reject_consumption_mutation()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $reject$
BEGIN
  RAISE EXCEPTION 'Shared-key economic consumption is append-only'
    USING ERRCODE='23514',CONSTRAINT='shared_key_consumption_append_only';
END;
$reject$;
CREATE TRIGGER shared_key_attempt_consumptions_no_change BEFORE UPDATE OR DELETE
  ON cinatoken_economic_consumer.shared_key_attempt_consumptions FOR EACH STATEMENT
  EXECUTE FUNCTION cinatoken_economic_consumer.reject_consumption_mutation();
CREATE TRIGGER shared_key_attempt_consumptions_no_truncate BEFORE TRUNCATE
  ON cinatoken_economic_consumer.shared_key_attempt_consumptions FOR EACH STATEMENT
  EXECUTE FUNCTION cinatoken_economic_consumer.reject_consumption_mutation();
CREATE TRIGGER shared_key_event_consumptions_no_change BEFORE UPDATE OR DELETE
  ON cinatoken_economic_consumer.shared_key_event_consumptions FOR EACH STATEMENT
  EXECUTE FUNCTION cinatoken_economic_consumer.reject_consumption_mutation();
CREATE TRIGGER shared_key_event_consumptions_no_truncate BEFORE TRUNCATE
  ON cinatoken_economic_consumer.shared_key_event_consumptions FOR EACH STATEMENT
  EXECUTE FUNCTION cinatoken_economic_consumer.reject_consumption_mutation();

-- One invocation and its caller's transaction either commit every decision,
-- seller balance increment and canonical portal ledger row, or commit none.
-- The event row lock serializes competing deliveries and resolves ACK loss.
CREATE FUNCTION cinatoken_economic_consumer.consume_shared_key_economic_event(
  p_event_id text)
RETURNS TABLE(out_event_id text,out_decision text,out_credited_attempts integer,
  out_pending_attempts integer,out_net_micros bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $consume$
DECLARE e cinatoken_economic_outbox.shared_key_economic_events%ROWTYPE;
DECLARE old cinatoken_economic_consumer.shared_key_event_consumptions%ROWTYPE;
DECLARE a record;
DECLARE account cinatoken_gateway.user_earnings%ROWTYPE;
DECLARE decision_value text;
DECLARE pending_reason_value text;
DECLARE gross_numeric numeric;
DECLARE gross_value bigint;
DECLARE fee_value bigint;
DECLARE net_value bigint;
DECLARE sum_net numeric := 0;
DECLARE credited_count integer := 0;
DECLARE pending_count integer := 0;
DECLARE observed_count integer := 0;
DECLARE attempt_time timestamptz;
DECLARE processed_time timestamptz;
BEGIN
  IF CURRENT_USER<>'cinatoken_gateway_migrator'
    OR SESSION_USER<>'cinatoken_gateway_shared_earning_consumer'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_event_id IS NULL OR pg_catalog.length(p_event_id)<1 THEN
    RAISE EXCEPTION 'Shared-key economic consumer identity or isolation differs'
      USING ERRCODE='23514',CONSTRAINT='shared_key_consumer_protocol';
  END IF;
  SELECT * INTO e FROM cinatoken_economic_outbox.shared_key_economic_events
    WHERE event_id=p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shared-key economic event is absent'
      USING ERRCODE='23503',CONSTRAINT='shared_key_consumer_event_absent';
  END IF;
  -- Defense in depth against a disabled legacy guard or a cutover mistake.
  PERFORM 1 FROM cinatoken_gateway.api_key_request_logs
    WHERE id=e.request_log_id FOR UPDATE;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM cinatoken_gateway.shared_key_earnings
      WHERE request_log_id=e.request_log_id) THEN
    RAISE EXCEPTION 'Legacy earning conflicts with economic event'
      USING ERRCODE='23514',CONSTRAINT='shared_key_consumer_legacy_conflict';
  END IF;
  SELECT * INTO old FROM cinatoken_economic_consumer.shared_key_event_consumptions
    WHERE event_id=p_event_id;
  IF FOUND THEN
    RETURN QUERY SELECT old.event_id,old.decision,old.credited_attempts,
      old.pending_attempts,old.total_net_micros;
    RETURN;
  END IF;
  FOR a IN SELECT o.*,q.seller_user_id,
      q.input_price_per_million,q.output_price_per_million,
      q.cache_read_price_per_million,q.cache_write_price_per_million,
      q.commission_rate,q.currency,q.price_unit,q.billing_mode,
      q.shared_key_id AS quote_shared_key_id,
      d.seller_user_id AS dispatch_seller_user_id
    FROM cinatoken_economic_outbox.shared_key_economic_event_attempts AS o
    JOIN cinatoken_economic_quotes.shared_key_dispatch_quote_attempts AS d
      ON d.attempt_id=o.attempt_id AND d.request_log_id=o.request_log_id
      AND d.attempt_index=o.attempt_index AND d.quote_version_id=o.quote_version_id
      AND d.transition_id=o.transition_id AND d.shared_key_id=o.shared_key_id
    JOIN cinatoken_economic_quotes.shared_key_quote_versions AS q
      ON q.version_id=o.quote_version_id
    WHERE o.event_id=p_event_id ORDER BY o.attempt_index
  LOOP
    observed_count:=observed_count+1;
    IF a.seller_user_id IS DISTINCT FROM a.dispatch_seller_user_id
      OR a.quote_shared_key_id IS DISTINCT FROM a.shared_key_id
      OR a.currency<>'USD' OR a.price_unit<>'per_million_tokens'
      OR a.billing_mode<>'shared_seller_key' THEN
      RAISE EXCEPTION 'Snapshot earning attempt quote identity differs'
        USING ERRCODE='23514',CONSTRAINT='shared_key_consumer_quote_identity';
    END IF;
    decision_value:='credited';
    pending_reason_value:=NULL;
    gross_value:=NULL; fee_value:=NULL; net_value:=NULL;
    IF e.buyer_charge_basis<>'actual' OR e.buyer_usage_certainty<>'actual' THEN
      decision_value:='pending_manual';
      pending_reason_value:='buyer_not_actual';
      pending_count:=pending_count+1;
    ELSIF a.usage_certainty NOT IN ('actual','confirmed_zero')
      OR a.provider_cost_certainty NOT IN ('actual','confirmed_zero') THEN
      decision_value:='pending_manual';
      pending_reason_value:='attempt_unresolved';
      pending_count:=pending_count+1;
    ELSIF (a.usage_certainty='actual' OR a.provider_cost_certainty='actual')
      AND a.evidence_kind NOT IN ('provider_usage','provider_bill') THEN
      -- A timeout/cancellation/manual label cannot silently become an
      -- approved payable fact merely by asserting actual in the type fields.
      decision_value:='pending_manual';
      pending_reason_value:='evidence_not_settleable';
      pending_count:=pending_count+1;
    ELSE
      -- USD/token-million multiplied by tokens gives whole micro-USD before
      -- rounding. All arithmetic is PostgreSQL NUMERIC, with no JS float.
      gross_numeric:=pg_catalog.round(
        a.input_tokens::numeric*a.input_price_per_million
        +a.output_tokens::numeric*a.output_price_per_million
        +a.cache_read_tokens::numeric*a.cache_read_price_per_million
        +a.cache_write_tokens::numeric*a.cache_write_price_per_million);
      IF gross_numeric<0 OR gross_numeric>9007199254740991 THEN
        RAISE EXCEPTION 'Snapshot seller gross exceeds reviewed micro bound'
          USING ERRCODE='22003',CONSTRAINT='shared_key_consumer_gross_bound';
      END IF;
      gross_value:=gross_numeric::bigint;
      fee_value:=pg_catalog.ceil(gross_value::numeric*a.commission_rate)::bigint;
      net_value:=gross_value-fee_value;
      credited_count:=credited_count+1;
      sum_net:=sum_net+net_value;
      IF sum_net>9007199254740991 THEN
        RAISE EXCEPTION 'Snapshot seller event total exceeds reviewed micro bound'
          USING ERRCODE='22003',CONSTRAINT='shared_key_consumer_total_bound';
      END IF;
    END IF;
    IF decision_value='credited' THEN
      INSERT INTO cinatoken_gateway.user_earnings(user_id)
        VALUES (a.seller_user_id) ON CONFLICT (user_id) DO NOTHING;
      -- Lock before taking the credit timestamp. An event that entered this
      -- function earlier can wait on its log or this account while another
      -- seller event commits first. A call-entry timestamp would then make
      -- the later and larger account balance appear older in the ledger.
      SELECT * INTO account FROM cinatoken_gateway.user_earnings
        WHERE user_id=a.seller_user_id FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Seller account is absent after ensure'
          USING ERRCODE='23503',CONSTRAINT='shared_key_consumer_account_absent';
      END IF;
      attempt_time:=GREATEST(pg_catalog.clock_timestamp(),
        account.updated_at+INTERVAL '1 microsecond');
    ELSE
      attempt_time:=pg_catalog.clock_timestamp();
    END IF;
    INSERT INTO cinatoken_economic_consumer.shared_key_attempt_consumptions
      (event_id,attempt_id,request_log_id,attempt_index,shared_key_id,
        transition_id,quote_version_id,seller_user_id,decision,pending_reason,
        usage_certainty,provider_cost_certainty,provider_cost_micros,
        input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,
        input_price_per_million,output_price_per_million,
        cache_read_price_per_million,cache_write_price_per_million,
        commission_rate,currency,price_unit,
        gross_micros,platform_fee_micros,net_micros,processed_at)
      VALUES (p_event_id,a.attempt_id,a.request_log_id,a.attempt_index,a.shared_key_id,
        a.transition_id,a.quote_version_id,a.seller_user_id,decision_value,
        pending_reason_value,a.usage_certainty,a.provider_cost_certainty,
        a.provider_cost_micros,a.input_tokens,a.output_tokens,a.cache_read_tokens,
        a.cache_write_tokens,a.input_price_per_million,a.output_price_per_million,
        a.cache_read_price_per_million,a.cache_write_price_per_million,
        a.commission_rate,a.currency,a.price_unit,
        gross_value,fee_value,net_value,attempt_time);
    IF decision_value='credited' THEN
      UPDATE cinatoken_gateway.user_earnings
        SET balance_micros=balance_micros+net_value,
          lifetime_earned_micros=lifetime_earned_micros+net_value,
          contribution_value_micros=contribution_value_micros+net_value,
          balance=(balance_micros+net_value)::numeric/1000000,
          lifetime_earned=(lifetime_earned_micros+net_value)::numeric/1000000,
          contribution_value=(contribution_value_micros+net_value)::numeric/1000000,
          updated_at=attempt_time
        WHERE user_id=a.seller_user_id
          AND balance_micros BETWEEN 0 AND 9007199254740991-net_value
          AND lifetime_earned_micros BETWEEN 0 AND 9007199254740991-net_value
          AND contribution_value_micros BETWEEN 0 AND 9007199254740991-net_value
        RETURNING * INTO account;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Seller account balance exceeds reviewed micro bound'
          USING ERRCODE='22003',CONSTRAINT='shared_key_consumer_balance_bound';
      END IF;
      INSERT INTO cinatoken_gateway.portal_ledger_entries
        (id,user_id,kind,amount_micros,balance_after_micros,
          locked_after_micros,reference_type,reference_id,created_at)
        VALUES (p_event_id || ':' || a.attempt_id::text || ':earning',
          a.seller_user_id,'shared_key_attempt_earning',net_value,
          account.balance_micros,account.locked_amount_micros,
          'shared_key_attempt_earning',a.attempt_id::text,account.updated_at);
    END IF;
  END LOOP;
  IF observed_count<>e.attempt_count OR observed_count<1 THEN
    RAISE EXCEPTION 'Economic event attempt coverage differs at consumption'
      USING ERRCODE='23514',CONSTRAINT='shared_key_consumer_attempt_coverage';
  END IF;
  processed_time:=pg_catalog.clock_timestamp();
  INSERT INTO cinatoken_economic_consumer.shared_key_event_consumptions
    (event_id,decision,attempt_count,credited_attempts,pending_attempts,
      total_net_micros,processed_at)
    VALUES (p_event_id,CASE WHEN pending_count=0 THEN 'credited'
      ELSE 'pending_manual' END,e.attempt_count,credited_count,pending_count,
      sum_net::bigint,processed_time);
  RETURN QUERY SELECT p_event_id,CASE WHEN pending_count=0 THEN 'credited'
    ELSE 'pending_manual' END,credited_count,pending_count,sum_net::bigint;
END;
$consume$;

REVOKE ALL ON ALL TABLES IN SCHEMA cinatoken_economic_consumer
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_shared_earning_consumer;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA cinatoken_economic_consumer
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_shared_earning_consumer;
GRANT USAGE ON SCHEMA cinatoken_economic_consumer
  TO cinatoken_gateway_shared_earning_consumer;
GRANT EXECUTE ON FUNCTION
  cinatoken_economic_consumer.consume_shared_key_economic_event(text)
  TO cinatoken_gateway_shared_earning_consumer;

DO $postflight$
DECLARE migrator_oid oid;
DECLARE runtime_oid oid;
DECLARE consumer_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  SELECT oid INTO consumer_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_shared_earning_consumer';
  IF pg_catalog.has_schema_privilege(runtime_oid,'cinatoken_economic_consumer','USAGE')
    OR NOT pg_catalog.has_schema_privilege(consumer_oid,'cinatoken_economic_consumer','USAGE')
    OR pg_catalog.has_schema_privilege(consumer_oid,'cinatoken_economic_consumer','CREATE')
    OR pg_catalog.has_table_privilege(consumer_oid,
      'cinatoken_economic_consumer.shared_key_attempt_consumptions','SELECT')
    OR pg_catalog.has_table_privilege(consumer_oid,
      'cinatoken_economic_consumer.shared_key_attempt_consumptions','INSERT')
    OR pg_catalog.has_table_privilege(consumer_oid,
      'cinatoken_economic_consumer.shared_key_event_consumptions','SELECT')
    OR NOT pg_catalog.has_function_privilege(consumer_oid,
      'cinatoken_economic_consumer.consume_shared_key_economic_event(text)','EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,
      'cinatoken_economic_consumer.consume_shared_key_economic_event(text)','EXECUTE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n,
        LATERAL pg_catalog.aclexplode(COALESCE(n.nspacl,
          pg_catalog.acldefault('n',n.nspowner))) acl
      WHERE n.oid='cinatoken_economic_consumer'::pg_catalog.regnamespace
        AND (n.nspowner<>migrator_oid OR acl.grantee NOT IN (migrator_oid,consumer_oid)
          OR (acl.grantee=consumer_oid AND
            (acl.privilege_type<>'USAGE' OR acl.is_grantable))))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c,
        LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,
          pg_catalog.acldefault('r',c.relowner))) acl
      WHERE c.relnamespace='cinatoken_economic_consumer'::pg_catalog.regnamespace
        AND c.relkind IN ('r','p','v','m','f')
        AND (c.relowner<>migrator_oid OR acl.grantee<>migrator_oid))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p,
        LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,
          pg_catalog.acldefault('f',p.proowner))) acl
      WHERE p.pronamespace='cinatoken_economic_consumer'::pg_catalog.regnamespace
        AND (p.proowner<>migrator_oid
          OR acl.grantee NOT IN (migrator_oid,consumer_oid)
          OR (acl.grantee=consumer_oid AND
            (p.oid<>'cinatoken_economic_consumer.consume_shared_key_economic_event(text)'::pg_catalog.regprocedure
              OR acl.privilege_type<>'EXECUTE' OR acl.is_grantable))))
  THEN
    RAISE EXCEPTION 'Snapshot earning consumer ACL exceeds reviewed contract';
  END IF;
END;
$postflight$;
