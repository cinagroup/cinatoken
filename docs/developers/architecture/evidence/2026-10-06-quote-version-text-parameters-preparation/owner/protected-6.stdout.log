-- REVIEW ONLY. A private, append-only seller quote contract. This is not a
-- formal migration or an active quote producer/consumer. Apply as the migrator
-- LOGIN in one transaction after all 73 formal migrations, with
-- SET LOCAL cinatoken.shared_key_quote_versions_activation = 'reviewed-v2'.
-- A separate schema keeps the ordinary runtime's broad legacy gateway-schema
-- grant (including later reruns) away from these financial source facts.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
-- Freeze the formal migration ledger while checking all 73 versions and creating
-- the proposal objects. This conflicts with concurrent migration DML.
LOCK TABLE cinatoken_gateway.schema_migrations IN SHARE MODE;

DO $preflight$
DECLARE migrator_oid oid;
DECLARE runtime_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_migrator';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_runtime';
  IF pg_catalog.current_setting('cinatoken.shared_key_quote_versions_activation', true)
       IS DISTINCT FROM 'reviewed-v2'
    OR CURRENT_USER <> 'cinatoken_gateway_migrator'
    OR SESSION_USER <> 'cinatoken_gateway_migrator'
    OR migrator_oid IS NULL OR runtime_oid IS NULL
    OR (SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE oid = migrator_oid) IS DISTINCT FROM TRUE
    OR (SELECT rolsuper FROM pg_catalog.pg_roles WHERE oid = runtime_oid) IS TRUE
    OR pg_catalog.pg_has_role(runtime_oid, migrator_oid, 'MEMBER')
    OR pg_catalog.pg_has_role(runtime_oid, 'pg_read_all_data'::pg_catalog.regrole, 'MEMBER')
    OR pg_catalog.pg_has_role(runtime_oid, 'pg_write_all_data'::pg_catalog.regrole, 'MEMBER')
    OR pg_catalog.to_regnamespace('cinatoken_economic_quotes') IS NOT NULL
    -- Exact sorted array comparison refuses a forged middle version even if
    -- the row count remains 73 and the terminal 0073 version still exists.
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
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class
      WHERE oid = 'cinatoken_gateway.shared_keys'::pg_catalog.regclass
        AND relowner = migrator_oid AND relkind = 'r'
        AND NOT relrowsecurity AND NOT relforcerowsecurity)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class
      WHERE oid = 'cinatoken_gateway.users'::pg_catalog.regclass
        AND relowner = migrator_oid AND relkind = 'r'
        AND NOT relrowsecurity AND NOT relforcerowsecurity)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
      WHERE attrelid = 'cinatoken_gateway.shared_keys'::pg_catalog.regclass
        AND attname = 'seller_user_id' AND atttypid = 'pg_catalog.text'::pg_catalog.regtype
        AND attnotnull AND NOT attisdropped)
    OR (SELECT count(*) FROM pg_catalog.pg_attribute
      WHERE attrelid = 'cinatoken_gateway.shared_keys'::pg_catalog.regclass
        AND attname IN ('input_price','output_price','cache_read_price','cache_write_price')
        AND atttypid = 'pg_catalog.numeric'::pg_catalog.regtype
        AND pg_catalog.format_type(atttypid, atttypmod) = 'numeric(18,6)'
        AND NOT attisdropped) <> 4 THEN
    RAISE EXCEPTION 'Shared-key quote activation or source contract differs';
  END IF;
END;
$preflight$;

CREATE SCHEMA cinatoken_economic_quotes AUTHORIZATION cinatoken_gateway_migrator;
REVOKE ALL ON SCHEMA cinatoken_economic_quotes FROM PUBLIC;
REVOKE ALL ON SCHEMA cinatoken_economic_quotes FROM cinatoken_gateway_runtime;

CREATE TABLE cinatoken_economic_quotes.shared_key_quote_versions (
  version_id text PRIMARY KEY,
  shared_key_id text NOT NULL REFERENCES cinatoken_gateway.shared_keys(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  seller_user_id text NOT NULL REFERENCES cinatoken_gateway.users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  input_price_per_million numeric(18,6) NOT NULL,
  output_price_per_million numeric(18,6) NOT NULL,
  cache_read_price_per_million numeric(18,6) NOT NULL,
  cache_write_price_per_million numeric(18,6) NOT NULL,
  commission_rate numeric(8,6) NOT NULL,
  currency text NOT NULL,
  price_unit text NOT NULL,
  billing_mode text NOT NULL,
  entitlement_version text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT shared_key_quote_version_id_valid
    CHECK (version_id = pg_catalog.btrim(version_id) AND pg_catalog.length(version_id) BETWEEN 1 AND 128),
  CONSTRAINT shared_key_quote_entitlement_valid
    CHECK (entitlement_version = pg_catalog.btrim(entitlement_version)
      AND pg_catalog.length(entitlement_version) BETWEEN 1 AND 128),
  CONSTRAINT shared_key_quote_prices_valid CHECK (
    input_price_per_million >= 0 AND input_price_per_million <> 'NaN'::numeric
    AND output_price_per_million >= 0 AND output_price_per_million <> 'NaN'::numeric
    AND cache_read_price_per_million >= 0 AND cache_read_price_per_million <> 'NaN'::numeric
    AND cache_write_price_per_million >= 0 AND cache_write_price_per_million <> 'NaN'::numeric),
  CONSTRAINT shared_key_quote_commission_valid
    CHECK (commission_rate >= 0 AND commission_rate <= 0.9),
  CONSTRAINT shared_key_quote_currency_valid CHECK (currency = 'USD'),
  CONSTRAINT shared_key_quote_unit_valid CHECK (price_unit = 'per_million_tokens'),
  CONSTRAINT shared_key_quote_billing_valid CHECK (billing_mode = 'shared_seller_key')
);

-- Facts remain immutable. A separate transition log supplies the active
-- version, revocation and effective timeline; there is no fixed end date to
-- edit when an unscheduled price or owner change occurs.
CREATE TABLE cinatoken_economic_quotes.shared_key_quote_transitions (
  transition_id text PRIMARY KEY,
  shared_key_id text NOT NULL REFERENCES cinatoken_gateway.shared_keys(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  supersedes_transition_id text REFERENCES
    cinatoken_economic_quotes.shared_key_quote_transitions(transition_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  transition_kind text NOT NULL,
  quote_version_id text UNIQUE REFERENCES
    cinatoken_economic_quotes.shared_key_quote_versions(version_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  seller_user_id text NOT NULL REFERENCES cinatoken_gateway.users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  transition_seq bigint NOT NULL,
  effective_at timestamptz NOT NULL,
  CONSTRAINT shared_key_quote_transition_id_valid CHECK (
    transition_id = pg_catalog.btrim(transition_id)
    AND pg_catalog.length(transition_id) BETWEEN 1 AND 128),
  CONSTRAINT shared_key_quote_transition_kind_valid CHECK (
    (transition_kind = 'activate' AND quote_version_id IS NOT NULL)
    OR (transition_kind = 'revoke' AND quote_version_id IS NULL)),
  CONSTRAINT shared_key_quote_transition_time_valid CHECK (pg_catalog.isfinite(effective_at)),
  CONSTRAINT shared_key_quote_transition_seq_valid CHECK (transition_seq > 0),
  CONSTRAINT shared_key_quote_transition_key_seq UNIQUE (shared_key_id, transition_seq)
);

-- Staging a quote locks its parent key, so the seller snapshot cannot race a
-- concurrent owner update. Activation is a separate append-only transition.
-- Both writes require a direct migrator LOGIN and READ COMMITTED.
CREATE FUNCTION cinatoken_economic_quotes.validate_shared_key_quote_insert()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path TO pg_catalog, pg_temp AS $validate$
DECLARE actual_seller text;
BEGIN
  IF TG_RELID <> 'cinatoken_economic_quotes.shared_key_quote_versions'::pg_catalog.regclass
    OR TG_NAME <> 'shared_key_quote_versions_validate_insert'
    OR TG_OP <> 'INSERT' OR TG_LEVEL <> 'ROW'
    OR CURRENT_USER <> 'cinatoken_gateway_migrator'
    OR SESSION_USER <> CURRENT_USER
    OR pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Shared-key quote insert protocol differs'
      USING ERRCODE = '23514', CONSTRAINT = 'shared_key_quote_insert_protocol';
  END IF;
  IF NEW.shared_key_id IS NULL OR NEW.seller_user_id IS NULL THEN
    RAISE EXCEPTION 'Shared-key quote identity is required'
      USING ERRCODE = '23514', CONSTRAINT = 'shared_key_quote_identity';
  END IF;
  SELECT seller_user_id INTO actual_seller
    FROM cinatoken_gateway.shared_keys WHERE id = NEW.shared_key_id FOR UPDATE;
  IF actual_seller IS DISTINCT FROM NEW.seller_user_id THEN
    RAISE EXCEPTION 'Shared-key quote owner differs from selected key'
      USING ERRCODE = '23514', CONSTRAINT = 'shared_key_quote_owner';
  END IF;
  IF EXISTS (SELECT 1 FROM cinatoken_economic_quotes.shared_key_quote_versions
      WHERE version_id = NEW.version_id) THEN
    RAISE EXCEPTION 'Shared-key quote version ID is already recorded'
      USING ERRCODE = '23505', CONSTRAINT = 'shared_key_quote_versions_pkey';
  END IF;
  -- The inserting LOGIN may supply an old timestamp, so replace it with the
  -- database clock. The migrator still owns DDL and remains a trusted actor.
  NEW.recorded_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END;
$validate$;

CREATE FUNCTION cinatoken_economic_quotes.reject_shared_key_quote_mutation()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path TO pg_catalog, pg_temp AS $reject$
BEGIN
  IF TG_RELID NOT IN (
    'cinatoken_economic_quotes.shared_key_quote_versions'::pg_catalog.regclass,
    'cinatoken_economic_quotes.shared_key_quote_transitions'::pg_catalog.regclass)
    OR (TG_NAME IN ('shared_key_quote_versions_no_change',
      'shared_key_quote_transitions_no_change')
      AND TG_OP NOT IN ('UPDATE','DELETE'))
    OR (TG_NAME IN ('shared_key_quote_versions_no_truncate',
      'shared_key_quote_transitions_no_truncate') AND TG_OP <> 'TRUNCATE')
    OR TG_NAME NOT IN ('shared_key_quote_versions_no_change',
      'shared_key_quote_versions_no_truncate',
      'shared_key_quote_transitions_no_change',
      'shared_key_quote_transitions_no_truncate') THEN
    RAISE EXCEPTION 'Shared-key quote mutation trigger binding differs';
  END IF;
  RAISE EXCEPTION 'Shared-key quote facts and transitions are append-only'
    USING ERRCODE = '23514', CONSTRAINT = 'shared_key_quote_versions_append_only';
END;
$reject$;

CREATE TRIGGER shared_key_quote_versions_validate_insert
  BEFORE INSERT ON cinatoken_economic_quotes.shared_key_quote_versions
  FOR EACH ROW EXECUTE FUNCTION cinatoken_economic_quotes.validate_shared_key_quote_insert();
CREATE TRIGGER shared_key_quote_versions_no_change
  BEFORE UPDATE OR DELETE ON cinatoken_economic_quotes.shared_key_quote_versions
  FOR EACH STATEMENT EXECUTE FUNCTION cinatoken_economic_quotes.reject_shared_key_quote_mutation();
CREATE TRIGGER shared_key_quote_versions_no_truncate
  BEFORE TRUNCATE ON cinatoken_economic_quotes.shared_key_quote_versions
  FOR EACH STATEMENT EXECUTE FUNCTION cinatoken_economic_quotes.reject_shared_key_quote_mutation();

-- One row per command keeps trigger-side row-lock checks independent of the
-- command snapshot. Zero-row INSERT ... ON CONFLICT is inert.
CREATE FUNCTION cinatoken_economic_quotes.validate_shared_key_quote_statement()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path TO pg_catalog, pg_temp AS $statement$
BEGIN
  IF TG_RELID <> 'cinatoken_economic_quotes.shared_key_quote_versions'::pg_catalog.regclass
    OR TG_NAME <> 'shared_key_quote_versions_one_row'
    OR TG_OP <> 'INSERT' OR TG_LEVEL <> 'STATEMENT' THEN
    RAISE EXCEPTION 'Shared-key quote statement trigger binding differs';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM new_quote_rows) > 1 THEN
    RAISE EXCEPTION 'Shared-key quote inserts require one row per statement'
      USING ERRCODE = '23514', CONSTRAINT = 'shared_key_quote_one_row';
  END IF;
  RETURN NULL;
END;
$statement$;
CREATE TRIGGER shared_key_quote_versions_one_row
  AFTER INSERT ON cinatoken_economic_quotes.shared_key_quote_versions
  REFERENCING NEW TABLE AS new_quote_rows
  FOR EACH STATEMENT EXECUTE FUNCTION cinatoken_economic_quotes.validate_shared_key_quote_statement();

-- A transition is an activation or a revocation. The caller must name the
-- currently visible head. Locking the shared key before reading that head
-- serializes competing operators and owner changes without mutable end dates.
CREATE FUNCTION cinatoken_economic_quotes.validate_shared_key_quote_transition()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path TO pg_catalog, pg_temp AS $transition$
DECLARE actual_seller text;
DECLARE prior_id text;
DECLARE prior_seq bigint;
DECLARE prior_kind text;
DECLARE prior_time timestamptz;
DECLARE quote_key text;
DECLARE quote_seller text;
DECLARE database_time timestamptz;
BEGIN
  IF TG_RELID <> 'cinatoken_economic_quotes.shared_key_quote_transitions'::pg_catalog.regclass
    OR TG_NAME <> 'shared_key_quote_transitions_validate_insert'
    OR TG_OP <> 'INSERT' OR TG_LEVEL <> 'ROW'
    OR CURRENT_USER <> 'cinatoken_gateway_migrator'
    OR SESSION_USER <> CURRENT_USER
    OR pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Shared-key quote transition protocol differs'
      USING ERRCODE = '23514', CONSTRAINT = 'shared_key_quote_transition_protocol';
  END IF;
  IF NEW.transition_seq IS NOT NULL OR NEW.effective_at IS NOT NULL THEN
    RAISE EXCEPTION 'Shared-key quote sequence and effective time are assigned by the database'
      USING ERRCODE = '23514', CONSTRAINT = 'shared_key_quote_server_time';
  END IF;
  SELECT seller_user_id INTO actual_seller
    FROM cinatoken_gateway.shared_keys WHERE id = NEW.shared_key_id FOR UPDATE;
  IF actual_seller IS DISTINCT FROM NEW.seller_user_id THEN
    RAISE EXCEPTION 'Shared-key quote transition owner differs from selected key'
      USING ERRCODE = '23514', CONSTRAINT = 'shared_key_quote_transition_owner';
  END IF;
  SELECT transition_id, transition_seq, transition_kind, effective_at
    INTO prior_id, prior_seq, prior_kind, prior_time
    FROM cinatoken_economic_quotes.shared_key_quote_transitions
    WHERE shared_key_id = NEW.shared_key_id
    ORDER BY transition_seq DESC LIMIT 1;
  IF NEW.supersedes_transition_id IS DISTINCT FROM prior_id THEN
    RAISE EXCEPTION 'Shared-key quote transition has a stale predecessor'
      USING ERRCODE = '23514', CONSTRAINT = 'shared_key_quote_stale_predecessor';
  END IF;
  IF NEW.transition_kind = 'revoke'
    AND (prior_id IS NULL OR prior_kind <> 'activate') THEN
    RAISE EXCEPTION 'Shared-key quote revoke requires an active predecessor'
      USING ERRCODE = '23514', CONSTRAINT = 'shared_key_quote_revoke_inactive';
  END IF;
  IF NEW.transition_kind = 'activate' THEN
    SELECT shared_key_id, seller_user_id INTO quote_key, quote_seller
      FROM cinatoken_economic_quotes.shared_key_quote_versions
      WHERE version_id = NEW.quote_version_id;
    IF quote_key IS DISTINCT FROM NEW.shared_key_id
      OR quote_seller IS DISTINCT FROM actual_seller THEN
      RAISE EXCEPTION 'Shared-key quote transition does not match its immutable quote'
        USING ERRCODE = '23514', CONSTRAINT = 'shared_key_quote_transition_version';
    END IF;
  END IF;
  database_time := pg_catalog.clock_timestamp();
  IF prior_time IS NOT NULL AND database_time <= prior_time THEN
    RAISE EXCEPTION 'Shared-key quote database clock did not advance'
      USING ERRCODE = '23514', CONSTRAINT = 'shared_key_quote_nonmonotonic_clock';
  END IF;
  NEW.transition_seq := COALESCE(prior_seq, 0) + 1;
  NEW.effective_at := database_time;
  RETURN NEW;
END;
$transition$;

CREATE TRIGGER shared_key_quote_transitions_validate_insert
  BEFORE INSERT ON cinatoken_economic_quotes.shared_key_quote_transitions
  FOR EACH ROW EXECUTE FUNCTION cinatoken_economic_quotes.validate_shared_key_quote_transition();
CREATE TRIGGER shared_key_quote_transitions_no_change
  BEFORE UPDATE OR DELETE ON cinatoken_economic_quotes.shared_key_quote_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION cinatoken_economic_quotes.reject_shared_key_quote_mutation();
CREATE TRIGGER shared_key_quote_transitions_no_truncate
  BEFORE TRUNCATE ON cinatoken_economic_quotes.shared_key_quote_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION cinatoken_economic_quotes.reject_shared_key_quote_mutation();

CREATE FUNCTION cinatoken_economic_quotes.validate_shared_key_quote_transition_statement()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path TO pg_catalog, pg_temp AS $statement$
BEGIN
  IF TG_RELID <> 'cinatoken_economic_quotes.shared_key_quote_transitions'::pg_catalog.regclass
    OR TG_NAME <> 'shared_key_quote_transitions_one_row'
    OR TG_OP <> 'INSERT' OR TG_LEVEL <> 'STATEMENT' THEN
    RAISE EXCEPTION 'Shared-key quote transition statement binding differs';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM new_transition_rows) > 1 THEN
    RAISE EXCEPTION 'Shared-key quote transitions require one row per statement'
      USING ERRCODE = '23514', CONSTRAINT = 'shared_key_quote_transition_one_row';
  END IF;
  RETURN NULL;
END;
$statement$;
CREATE TRIGGER shared_key_quote_transitions_one_row
  AFTER INSERT ON cinatoken_economic_quotes.shared_key_quote_transitions
  REFERENCING NEW TABLE AS new_transition_rows
  FOR EACH STATEMENT EXECUTE FUNCTION
    cinatoken_economic_quotes.validate_shared_key_quote_transition_statement();

-- Once any transition exists, the base-key owner and newest transition owner
-- must agree at commit. A transfer therefore updates shared_keys and appends a
-- full new quote/activation (or a revocation) in one transaction. This check
-- intentionally rejects a bare owner update that leaves the prior quote live.
CREATE FUNCTION cinatoken_economic_quotes.guard_shared_key_quote_owner_transfer()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path TO pg_catalog, pg_temp AS $owner$
DECLARE actual_seller text;
DECLARE transition_seller text;
BEGIN
  IF TG_RELID <> 'cinatoken_gateway.shared_keys'::pg_catalog.regclass
    OR TG_NAME <> 'shared_key_quote_owner_transfer_guard'
    OR TG_OP <> 'UPDATE' OR TG_LEVEL <> 'ROW' THEN
    RAISE EXCEPTION 'Shared-key quote owner guard binding differs';
  END IF;
  SELECT seller_user_id INTO actual_seller FROM cinatoken_gateway.shared_keys
    WHERE id = NEW.id;
  SELECT seller_user_id INTO transition_seller
    FROM cinatoken_economic_quotes.shared_key_quote_transitions
    WHERE shared_key_id = NEW.id ORDER BY transition_seq DESC LIMIT 1;
  IF FOUND AND actual_seller IS DISTINCT FROM transition_seller THEN
    RAISE EXCEPTION 'Shared-key owner transfer requires a matching quote transition'
      USING ERRCODE = '23514', CONSTRAINT = 'shared_key_quote_owner_transfer';
  END IF;
  RETURN NULL;
END;
$owner$;
CREATE CONSTRAINT TRIGGER shared_key_quote_owner_transfer_guard
  AFTER UPDATE OF seller_user_id ON cinatoken_gateway.shared_keys
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION cinatoken_economic_quotes.guard_shared_key_quote_owner_transfer();

-- Sequence lookup is the exact historical contract for a dispatched attempt:
-- the attempt must retain transition_id/version_id instead of relying on a
-- later wall-clock query. Time lookup is useful for retrospective audit after
-- the transition commits; an uncommitted transition is naturally invisible.
CREATE FUNCTION cinatoken_economic_quotes.resolve_shared_key_quote_at_sequence(
  p_shared_key_id text, p_transition_seq bigint)
RETURNS TABLE (
  transition_id text, transition_seq bigint, effective_at timestamptz,
  transition_kind text, quote_version_id text, seller_user_id text,
  input_price_per_million numeric(18,6), output_price_per_million numeric(18,6),
  cache_read_price_per_million numeric(18,6), cache_write_price_per_million numeric(18,6),
  commission_rate numeric(8,6), currency text, price_unit text,
  billing_mode text, entitlement_version text)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path TO pg_catalog, pg_temp AS $resolve$
  SELECT t.transition_id, t.transition_seq, t.effective_at,
    t.transition_kind, t.quote_version_id, t.seller_user_id,
    q.input_price_per_million, q.output_price_per_million,
    q.cache_read_price_per_million, q.cache_write_price_per_million,
    q.commission_rate, q.currency, q.price_unit,
    q.billing_mode, q.entitlement_version
  FROM cinatoken_economic_quotes.shared_key_quote_transitions AS t
  LEFT JOIN cinatoken_economic_quotes.shared_key_quote_versions AS q
    ON q.version_id = t.quote_version_id
  WHERE t.shared_key_id = p_shared_key_id AND t.transition_seq <= p_transition_seq
  ORDER BY t.transition_seq DESC LIMIT 1;
$resolve$;

CREATE FUNCTION cinatoken_economic_quotes.resolve_shared_key_quote_at_time(
  p_shared_key_id text, p_effective_at timestamptz)
RETURNS TABLE (
  transition_id text, transition_seq bigint, effective_at timestamptz,
  transition_kind text, quote_version_id text, seller_user_id text,
  input_price_per_million numeric(18,6), output_price_per_million numeric(18,6),
  cache_read_price_per_million numeric(18,6), cache_write_price_per_million numeric(18,6),
  commission_rate numeric(8,6), currency text, price_unit text,
  billing_mode text, entitlement_version text)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path TO pg_catalog, pg_temp AS $resolve$
  SELECT resolved.* FROM (
    SELECT t.transition_seq
    FROM cinatoken_economic_quotes.shared_key_quote_transitions AS t
    WHERE t.shared_key_id = p_shared_key_id AND t.effective_at <= p_effective_at
    ORDER BY t.transition_seq DESC LIMIT 1
  ) AS head
  CROSS JOIN LATERAL
    cinatoken_economic_quotes.resolve_shared_key_quote_at_sequence(
      p_shared_key_id, head.transition_seq) AS resolved;
$resolve$;

-- This is only a review-time selector, not a connected dispatch producer.
-- A future producer must call it in the SAME transaction that persists the
-- attempt's transition_id and quote_version_id. FOR SHARE makes a concurrent
-- revoke or owner transfer wait until that attempt transaction finishes; when
-- revoke commits first, this selector waits and then rejects the attempt.
CREATE FUNCTION cinatoken_economic_quotes.claim_shared_key_quote_for_dispatch(
  p_shared_key_id text)
RETURNS TABLE (
  transition_id text, transition_seq bigint, effective_at timestamptz,
  quote_version_id text, seller_user_id text,
  input_price_per_million numeric(18,6), output_price_per_million numeric(18,6),
  cache_read_price_per_million numeric(18,6), cache_write_price_per_million numeric(18,6),
  commission_rate numeric(8,6), currency text, price_unit text,
  billing_mode text, entitlement_version text)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path TO pg_catalog, pg_temp AS $claim$
DECLARE actual_seller text;
DECLARE head_seq bigint;
DECLARE head_kind text;
DECLARE head_seller text;
BEGIN
  IF CURRENT_USER <> 'cinatoken_gateway_migrator'
    OR SESSION_USER <> CURRENT_USER
    OR pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Shared-key dispatch quote claim protocol differs'
      USING ERRCODE = '23514', CONSTRAINT = 'shared_key_quote_claim_protocol';
  END IF;
  SELECT sk.seller_user_id INTO actual_seller FROM cinatoken_gateway.shared_keys AS sk
    WHERE sk.id = p_shared_key_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shared-key dispatch quote is unavailable'
      USING ERRCODE = '23514', CONSTRAINT = 'shared_key_quote_unavailable';
  END IF;
  SELECT t.transition_seq, t.transition_kind, t.seller_user_id
    INTO head_seq, head_kind, head_seller
    FROM cinatoken_economic_quotes.shared_key_quote_transitions AS t
    WHERE t.shared_key_id = p_shared_key_id
    ORDER BY t.transition_seq DESC LIMIT 1;
  IF head_kind IS DISTINCT FROM 'activate'
    OR head_seller IS DISTINCT FROM actual_seller THEN
    RAISE EXCEPTION 'Shared-key dispatch quote is unavailable'
      USING ERRCODE = '23514', CONSTRAINT = 'shared_key_quote_unavailable';
  END IF;
  RETURN QUERY SELECT r.transition_id, r.transition_seq, r.effective_at,
    r.quote_version_id, r.seller_user_id,
    r.input_price_per_million, r.output_price_per_million,
    r.cache_read_price_per_million, r.cache_write_price_per_million,
    r.commission_rate, r.currency, r.price_unit,
    r.billing_mode, r.entitlement_version
    FROM cinatoken_economic_quotes.resolve_shared_key_quote_at_sequence(
      p_shared_key_id, head_seq) AS r;
END;
$claim$;

REVOKE ALL ON TABLE cinatoken_economic_quotes.shared_key_quote_versions
  FROM PUBLIC, cinatoken_gateway_runtime;
REVOKE ALL ON TABLE cinatoken_economic_quotes.shared_key_quote_transitions
  FROM PUBLIC, cinatoken_gateway_runtime;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA cinatoken_economic_quotes
  FROM PUBLIC, cinatoken_gateway_runtime;

DO $postflight$
DECLARE runtime_oid oid;
BEGIN
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_runtime';
  IF runtime_oid IS NULL
    OR pg_catalog.has_schema_privilege(runtime_oid, 'cinatoken_economic_quotes', 'USAGE')
    OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY[
      'cinatoken_economic_quotes.shared_key_quote_versions',
      'cinatoken_economic_quotes.shared_key_quote_transitions']::text[]) AS t(name)
      CROSS JOIN pg_catalog.unnest(ARRAY[
        'SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']::text[]) AS p(privilege)
      WHERE pg_catalog.has_table_privilege(runtime_oid, t.name, p.privilege))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc
      WHERE pronamespace = 'cinatoken_economic_quotes'::pg_catalog.regnamespace
        AND pg_catalog.has_function_privilege(runtime_oid, oid, 'EXECUTE')) THEN
    RAISE EXCEPTION 'Shared-key quote runtime ACL is wider than reviewed contract';
  END IF;
END;
$postflight$;
