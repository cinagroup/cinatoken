-- REVIEW ONLY. Additive, default-off candidate after the v342 delivery proposal.
-- Install as the direct migrator LOGIN in one transaction with:
--   SET LOCAL cinatoken.shared_key_delivery_backlog_observation_activation = 'reviewed-v1';
-- This grants no table read privilege and does not wire a Worker or alert.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
-- SHARE UPDATE EXCLUSIVE permits ordinary job writes while excluding
-- concurrent index replacement during the catalog preflight and grant.
LOCK TABLE cinatoken_economic_delivery.shared_key_event_delivery_jobs
  IN SHARE UPDATE EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid;
DECLARE delivery_oid oid;
DECLARE runtime_oid oid;
DECLARE consumer_oid oid;
DECLARE recovery_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO delivery_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_shared_earning_delivery';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  SELECT oid INTO consumer_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_shared_earning_consumer';
  SELECT oid INTO recovery_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_shared_earning_recovery';
  IF pg_catalog.current_setting(
      'cinatoken.shared_key_delivery_backlog_observation_activation',true)
        IS DISTINCT FROM 'reviewed-v1'
    OR CURRENT_USER<>'cinatoken_gateway_migrator' OR SESSION_USER<>CURRENT_USER
    OR migrator_oid IS NULL OR delivery_oid IS NULL OR runtime_oid IS NULL
    OR consumer_oid IS NULL OR recovery_oid IS NULL
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles
      WHERE oid=delivery_oid AND (NOT rolcanlogin OR rolsuper OR rolcreaterole
        OR rolcreatedb OR rolreplication OR rolbypassrls))
    OR pg_catalog.pg_has_role(delivery_oid,migrator_oid,'MEMBER')
    OR pg_catalog.pg_has_role(delivery_oid,runtime_oid,'MEMBER')
    OR pg_catalog.pg_has_role(delivery_oid,consumer_oid,'MEMBER')
    OR pg_catalog.pg_has_role(delivery_oid,
      'pg_read_all_data'::pg_catalog.regrole,'MEMBER')
    OR pg_catalog.to_regprocedure(
      'cinatoken_economic_delivery.observe_backlog(integer)') IS NOT NULL
    OR (SELECT nspowner FROM pg_catalog.pg_namespace
      WHERE oid='cinatoken_economic_delivery'::pg_catalog.regnamespace)
        <>migrator_oid
    OR (SELECT relowner FROM pg_catalog.pg_class
      WHERE oid='cinatoken_economic_delivery.shared_key_event_delivery_jobs'::pg_catalog.regclass)
        <>migrator_oid
    OR pg_catalog.has_table_privilege(delivery_oid,
      'cinatoken_economic_delivery.shared_key_event_delivery_jobs','SELECT')
    OR NOT pg_catalog.has_schema_privilege(delivery_oid,
      'cinatoken_economic_delivery','USAGE')
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid
      WHERE i.indrelid=
        'cinatoken_economic_delivery.shared_key_event_delivery_jobs'::pg_catalog.regclass
        AND c.relnamespace='cinatoken_economic_delivery'::pg_catalog.regnamespace
        AND c.relowner=migrator_oid
        AND i.indisvalid AND i.indisready AND i.indislive AND NOT i.indisunique
        AND ((c.relname='shared_key_delivery_pending_due' AND
          pg_catalog.pg_get_indexdef(c.oid)=
            'CREATE INDEX shared_key_delivery_pending_due ON cinatoken_economic_delivery.shared_key_event_delivery_jobs USING btree (next_attempt_at, event_id) WHERE (status = ''pending''::text)')
          OR (c.relname='shared_key_delivery_expired_lease' AND
          pg_catalog.pg_get_indexdef(c.oid)=
            'CREATE INDEX shared_key_delivery_expired_lease ON cinatoken_economic_delivery.shared_key_event_delivery_jobs USING btree (lease_until, event_id) WHERE (status = ''leased''::text)')
          OR (c.relname='shared_key_delivery_dead_letter' AND
          pg_catalog.pg_get_indexdef(c.oid)=
            'CREATE INDEX shared_key_delivery_dead_letter ON cinatoken_economic_delivery.shared_key_event_delivery_jobs USING btree (dead_at, event_id) WHERE (status = ''dead_letter''::text)')))<>3
  THEN
    RAISE EXCEPTION 'Economic delivery backlog observation prerequisite differs'
      USING ERRCODE='23514',CONSTRAINT='shared_key_delivery_backlog_preflight';
  END IF;
END;
$preflight$;

-- Every sample is an ordered index-prefix of at most cap+1 jobs. Counts are
-- capped lower bounds when saturated, never exact full-table counts. The age
-- uses the earliest pending next_attempt_at, not source-event residence time.
CREATE FUNCTION cinatoken_economic_delivery.observe_backlog(p_cap integer)
RETURNS TABLE(out_observed_at timestamptz,out_cap integer,
  out_pending_count integer,out_pending_saturated boolean,
  out_due_count integer,out_due_saturated boolean,
  out_leased_count integer,out_leased_saturated boolean,
  out_dead_letter_count integer,out_dead_letter_saturated boolean,
  out_oldest_pending_due_age_seconds bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp
SET enable_seqscan TO off
AS $observe$
DECLARE sampled_at timestamptz;
BEGIN
  IF CURRENT_USER<>'cinatoken_gateway_migrator'
    OR SESSION_USER<>'cinatoken_gateway_shared_earning_delivery'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_cap IS NULL OR p_cap NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Economic delivery backlog observation protocol differs'
      USING ERRCODE='23514',CONSTRAINT='shared_key_delivery_backlog_protocol';
  END IF;
  sampled_at:=pg_catalog.clock_timestamp();
  RETURN QUERY
  WITH pending_sample AS MATERIALIZED (
    SELECT next_attempt_at FROM
      cinatoken_economic_delivery.shared_key_event_delivery_jobs
    WHERE status='pending'
    ORDER BY next_attempt_at,event_id LIMIT p_cap+1
  ), pending_due_sample AS MATERIALIZED (
    SELECT 1 FROM cinatoken_economic_delivery.shared_key_event_delivery_jobs
    WHERE status='pending' AND next_attempt_at<=sampled_at
    ORDER BY next_attempt_at,event_id LIMIT p_cap+1
  ), leased_sample AS MATERIALIZED (
    SELECT 1 FROM cinatoken_economic_delivery.shared_key_event_delivery_jobs
    WHERE status='leased'
    ORDER BY lease_until,event_id LIMIT p_cap+1
  ), expired_lease_sample AS MATERIALIZED (
    SELECT 1 FROM cinatoken_economic_delivery.shared_key_event_delivery_jobs
    WHERE status='leased' AND lease_until<=sampled_at
    ORDER BY lease_until,event_id LIMIT p_cap+1
  ), dead_letter_sample AS MATERIALIZED (
    SELECT 1 FROM cinatoken_economic_delivery.shared_key_event_delivery_jobs
    WHERE status='dead_letter'
    ORDER BY dead_at,event_id LIMIT p_cap+1
  ), counts AS (
    SELECT (SELECT pg_catalog.count(*)::integer FROM pending_sample) AS pending_n,
      (SELECT pg_catalog.count(*)::integer FROM pending_due_sample) AS pending_due_n,
      (SELECT pg_catalog.count(*)::integer FROM leased_sample) AS leased_n,
      (SELECT pg_catalog.count(*)::integer FROM expired_lease_sample) AS expired_n,
      (SELECT pg_catalog.count(*)::integer FROM dead_letter_sample) AS dead_n,
      (SELECT pg_catalog.min(next_attempt_at) FROM pending_sample) AS oldest_pending_due
  )
  SELECT sampled_at,p_cap,
    LEAST(pending_n,p_cap),pending_n>p_cap,
    LEAST(pending_due_n+expired_n,p_cap),
      pending_due_n+expired_n>p_cap,
    LEAST(leased_n,p_cap),leased_n>p_cap,
    LEAST(dead_n,p_cap),dead_n>p_cap,
    CASE WHEN oldest_pending_due IS NULL THEN NULL::bigint ELSE
      GREATEST(0::numeric,
        pg_catalog.floor(EXTRACT(EPOCH FROM sampled_at-oldest_pending_due)))::bigint
    END
  FROM counts;
END;
$observe$;

REVOKE ALL ON FUNCTION cinatoken_economic_delivery.observe_backlog(integer)
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_shared_earning_consumer,
    cinatoken_gateway_shared_earning_delivery,
    cinatoken_gateway_shared_earning_recovery;
GRANT EXECUTE ON FUNCTION cinatoken_economic_delivery.observe_backlog(integer)
  TO cinatoken_gateway_shared_earning_delivery;

DO $postflight$
DECLARE migrator_oid oid;
DECLARE delivery_oid oid;
DECLARE runtime_oid oid;
DECLARE consumer_oid oid;
DECLARE recovery_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO delivery_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_shared_earning_delivery';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  SELECT oid INTO consumer_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_shared_earning_consumer';
  SELECT oid INTO recovery_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_shared_earning_recovery';
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc
      WHERE oid='cinatoken_economic_delivery.observe_backlog(integer)'::pg_catalog.regprocedure
        AND proowner=migrator_oid AND prosecdef
        AND proconfig @> ARRAY['search_path=pg_catalog, pg_temp','enable_seqscan=off'])
    OR NOT pg_catalog.has_function_privilege(delivery_oid,
      'cinatoken_economic_delivery.observe_backlog(integer)','EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,
      'cinatoken_economic_delivery.observe_backlog(integer)','EXECUTE')
    OR pg_catalog.has_function_privilege(consumer_oid,
      'cinatoken_economic_delivery.observe_backlog(integer)','EXECUTE')
    OR pg_catalog.has_function_privilege(recovery_oid,
      'cinatoken_economic_delivery.observe_backlog(integer)','EXECUTE')
    OR pg_catalog.has_table_privilege(delivery_oid,
      'cinatoken_economic_delivery.shared_key_event_delivery_jobs','SELECT')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p,
        LATERAL pg_catalog.aclexplode(p.proacl) acl
      WHERE p.oid='cinatoken_economic_delivery.observe_backlog(integer)'::pg_catalog.regprocedure
        AND (acl.grantee NOT IN (migrator_oid,delivery_oid)
          OR (acl.grantee=delivery_oid AND
            (acl.privilege_type<>'EXECUTE' OR acl.is_grantable))))
  THEN
    RAISE EXCEPTION 'Economic delivery backlog observation ACL differs';
  END IF;
END;
$postflight$;
