-- REVIEW ONLY. A DB verification primitive for a separately issued seller
-- stats.read claim. No HTTP route or credited-usage reader is activated.
-- Apply as the direct migrator LOGIN in one transaction with:
--   SET LOCAL cinatoken.shared_key_stats_claim_install = 'reviewed-v1';
-- Requires PostgreSQL 18 with pgcrypto available and not already installed.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
LOCK TABLE cinatoken_gateway.schema_migrations IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid;
DECLARE runtime_oid oid;
DECLARE reader_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  SELECT oid INTO reader_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_stats_reader';
  IF CURRENT_USER<>'cinatoken_gateway_migrator'
    OR SESSION_USER<>CURRENT_USER
    OR pg_catalog.current_setting(
      'cinatoken.shared_key_stats_claim_install',true)
        IS DISTINCT FROM 'reviewed-v1'
    OR migrator_oid IS NULL OR runtime_oid IS NULL OR reader_oid IS NULL
    OR (SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole
        AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls
        AND NOT rolinherit FROM pg_catalog.pg_roles WHERE oid=reader_oid)
          IS DISTINCT FROM true
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
      WHERE member=reader_oid OR roleid=reader_oid)
    OR pg_catalog.pg_has_role(runtime_oid,reader_oid,'MEMBER')
    OR (SELECT pg_catalog.count(*) FROM cinatoken_gateway.schema_migrations)<>73
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\n'
        ORDER BY version COLLATE "C")) FROM cinatoken_gateway.schema_migrations)
          <>'ca1ea96a1b4bcd0675642f30dcf48042'
    OR pg_catalog.to_regnamespace('cinatoken_stats_claim') IS NOT NULL
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname='pgcrypto')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_available_extensions
      WHERE name='pgcrypto')
  THEN
    RAISE EXCEPTION 'Signed stats claim install contract differs'
      USING ERRCODE='23514',CONSTRAINT='shared_key_stats_claim_install';
  END IF;
END;
$preflight$;

CREATE SCHEMA cinatoken_stats_claim AUTHORIZATION cinatoken_gateway_migrator;
REVOKE ALL ON SCHEMA cinatoken_stats_claim FROM PUBLIC,
  cinatoken_gateway_runtime;
CREATE EXTENSION pgcrypto WITH SCHEMA cinatoken_stats_claim;

CREATE TABLE cinatoken_stats_claim.keys (
  key_id text PRIMARY KEY CHECK (key_id ~ '^[A-Za-z0-9:_-]{1,64}$'),
  secret bytea NOT NULL CHECK (pg_catalog.octet_length(secret)=32),
  not_before timestamptz NOT NULL,
  not_after timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (not_after>not_before)
);
CREATE TABLE cinatoken_stats_claim.used_nonces (
  key_id text NOT NULL REFERENCES cinatoken_stats_claim.keys(key_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  nonce uuid NOT NULL,
  expires_epoch bigint NOT NULL,
  used_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (key_id,nonce)
);
REVOKE ALL ON cinatoken_stats_claim.keys,
  cinatoken_stats_claim.used_nonces
  FROM PUBLIC,cinatoken_gateway_runtime,cinatoken_gateway_stats_reader;

-- The issuer and DB share a 32-byte secret provisioned outside this SQL.
-- IDs use restricted ASCII, so comma-separated sorted key IDs are canonical.
-- Payload: v1|stats.read|key_id|seller_id|sorted_key_ids|expiry_epoch|nonce.
-- This primitive consumes the nonce in the caller's transaction. A future
-- credited-usage reader must call it and project rows in that same transaction.
CREATE FUNCTION cinatoken_stats_claim.verify_seller_stats_claim(
  p_key_id text,p_seller_id text,p_key_ids text[],
  p_expires_epoch bigint,p_nonce uuid,p_signature bytea)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $verify$
DECLARE k record;
DECLARE now_at timestamptz;
DECLARE now_epoch bigint;
DECLARE ordered_ids text[];
DECLARE payload text;
DECLARE expected bytea;
DECLARE diff integer := 0;
DECLARE changed integer;
DECLARE i integer;
BEGIN
  IF CURRENT_USER<>'cinatoken_gateway_migrator'
    OR SESSION_USER<>'cinatoken_gateway_stats_reader'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_key_id IS NULL OR p_key_id !~ '^[A-Za-z0-9:_-]{1,64}$'
    OR p_seller_id IS NULL OR p_seller_id !~ '^[A-Za-z0-9:_-]{1,128}$'
    OR p_key_ids IS NULL OR pg_catalog.cardinality(p_key_ids) NOT BETWEEN 1 AND 200
    OR p_expires_epoch IS NULL OR p_nonce IS NULL
    OR p_signature IS NULL OR pg_catalog.octet_length(p_signature)<>32
    OR EXISTS (SELECT 1 FROM pg_catalog.unnest(p_key_ids) AS x(id)
      WHERE id IS NULL OR id !~ '^[A-Za-z0-9:_-]{1,128}$') THEN
    RAISE EXCEPTION 'Signed stats claim is invalid'
      USING ERRCODE='23514',CONSTRAINT='shared_key_stats_claim_invalid';
  END IF;
  SELECT pg_catalog.array_agg(id ORDER BY id COLLATE "C") INTO ordered_ids
    FROM (SELECT DISTINCT id COLLATE "C" AS id
      FROM pg_catalog.unnest(p_key_ids) AS x(id)) AS unique_ids;
  IF ordered_ids IS DISTINCT FROM p_key_ids THEN
    RAISE EXCEPTION 'Signed stats claim scope is not canonical'
      USING ERRCODE='23514',CONSTRAINT='shared_key_stats_claim_scope';
  END IF;
  now_at:=pg_catalog.clock_timestamp();
  now_epoch:=pg_catalog.floor(pg_catalog.date_part('epoch',now_at))::bigint;
  IF p_expires_epoch<=now_epoch OR p_expires_epoch>now_epoch+300 THEN
    RAISE EXCEPTION 'Signed stats claim has expired or exceeds five minutes'
      USING ERRCODE='23514',CONSTRAINT='shared_key_stats_claim_expiry';
  END IF;
  SELECT secret,not_before,not_after,revoked_at INTO k
    FROM cinatoken_stats_claim.keys WHERE key_id=p_key_id;
  IF NOT FOUND OR k.revoked_at IS NOT NULL OR now_at<k.not_before
    OR now_at>=k.not_after THEN
    RAISE EXCEPTION 'Signed stats claim key is unavailable'
      USING ERRCODE='23514',CONSTRAINT='shared_key_stats_claim_key';
  END IF;
  payload:='v1|stats.read|'||p_key_id||'|'||p_seller_id||'|'
    ||pg_catalog.array_to_string(p_key_ids,',')||'|'
    ||p_expires_epoch::text||'|'||p_nonce::text;
  expected:=cinatoken_stats_claim.hmac(
    pg_catalog.convert_to(payload,'UTF8'),k.secret,'sha256');
  FOR i IN 0..31 LOOP
    diff:=diff | (pg_catalog.get_byte(expected,i)
      # pg_catalog.get_byte(p_signature,i));
  END LOOP;
  IF diff<>0 THEN
    RAISE EXCEPTION 'Signed stats claim signature differs'
      USING ERRCODE='23514',CONSTRAINT='shared_key_stats_claim_signature';
  END IF;
  INSERT INTO cinatoken_stats_claim.used_nonces
    (key_id,nonce,expires_epoch) VALUES (p_key_id,p_nonce,p_expires_epoch)
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>1 THEN
    RAISE EXCEPTION 'Signed stats claim was already consumed'
      USING ERRCODE='23514',CONSTRAINT='shared_key_stats_claim_replay';
  END IF;
  RETURN p_seller_id;
END;
$verify$;
REVOKE ALL ON FUNCTION cinatoken_stats_claim.verify_seller_stats_claim(
  text,text,text[],bigint,uuid,bytea)
  FROM PUBLIC,cinatoken_gateway_runtime;
GRANT USAGE ON SCHEMA cinatoken_stats_claim
  TO cinatoken_gateway_stats_reader;
GRANT EXECUTE ON FUNCTION cinatoken_stats_claim.verify_seller_stats_claim(
  text,text,text[],bigint,uuid,bytea)
  TO cinatoken_gateway_stats_reader;

DO $postflight$
DECLARE migrator_oid oid;
DECLARE reader_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO reader_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_stats_reader';
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid IN ('cinatoken_stats_claim.keys'::pg_catalog.regclass,
        'cinatoken_stats_claim.used_nonces'::pg_catalog.regclass)
        AND (c.relowner<>migrator_oid OR c.relkind<>'r'
          OR pg_catalog.has_table_privilege(reader_oid,c.oid,
            'SELECT,INSERT,UPDATE,DELETE')))
    OR pg_catalog.has_schema_privilege('cinatoken_gateway_runtime',
      'cinatoken_stats_claim','USAGE')
    OR pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
      'cinatoken_stats_claim.verify_seller_stats_claim(text,text,text[],bigint,uuid,bytea)',
      'EXECUTE')
    OR NOT pg_catalog.has_function_privilege(reader_oid,
      'cinatoken_stats_claim.verify_seller_stats_claim(text,text,text[],bigint,uuid,bytea)',
      'EXECUTE')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      WHERE p.oid='cinatoken_stats_claim.verify_seller_stats_claim(text,text,text[],bigint,uuid,bytea)'::pg_catalog.regprocedure
        AND p.proowner=migrator_oid AND p.prosecdef AND p.provolatile='v'
        AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[])
  THEN
    RAISE EXCEPTION 'Signed stats claim postflight differs'
      USING ERRCODE='23514',CONSTRAINT='shared_key_stats_claim_postflight';
  END IF;
END;
$postflight$;
