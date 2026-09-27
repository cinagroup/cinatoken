-- Expand-only immutable settlement facts and outbox after 0069. C03 remains disabled.
-- The migrator's transaction fails promptly on contested catalog/FK locks.
SET LOCAL lock_timeout = '2s';

-- This stores the existing v1 Images post-result settlement input, NOT a pre-dispatch quote,
-- funds ledger, authorization decision, recovery lease or permission to charge an unknown.
ALTER TABLE cinatoken_gateway.request_dispatch_intents
  ADD CONSTRAINT request_dispatch_intents_claim_identity UNIQUE
    (request_id, attempt_index, user_id, api_key_id, workspace_id, operation, context_sha256, dispatch_claim_id);

CREATE TABLE cinatoken_gateway.request_usage_settlements (
  request_id text PRIMARY KEY,
  attempt_index integer NOT NULL,
  user_id text NOT NULL,
  api_key_id text NOT NULL,
  workspace_id text NOT NULL,
  operation text NOT NULL,
  context_sha256 text NOT NULL,
  dispatch_claim_id text NOT NULL,
  payload_version integer NOT NULL CHECK (payload_version = 1),
  -- Preserve canonical encoder bytes. jsonb would reorder/normalize the hashed representation.
  payload_json text NOT NULL CHECK (octet_length(payload_json) BETWEEN 1 AND 262144),
  payload_sha256 text NOT NULL CHECK (payload_sha256 COLLATE "C" ~ '^[0-9a-f]{64}$'),
  recorded_at text NOT NULL CHECK (recorded_at COLLATE "C" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'),
  created_at_ms bigint NOT NULL DEFAULT 0 CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  CONSTRAINT request_usage_settlements_claim FOREIGN KEY
    (request_id, attempt_index, user_id, api_key_id, workspace_id, operation, context_sha256, dispatch_claim_id)
    REFERENCES cinatoken_gateway.request_dispatch_intents
    (request_id, attempt_index, user_id, api_key_id, workspace_id, operation, context_sha256, dispatch_claim_id),
  CONSTRAINT request_usage_settlements_event UNIQUE (request_id, payload_sha256, created_at_ms),
  CHECK (payload_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(payload_json, 'UTF8')), 'hex'))
);
CREATE INDEX request_usage_settlements_scope_scan
  ON cinatoken_gateway.request_usage_settlements(user_id, workspace_id, created_at_ms, request_id);

-- An immutable discovery entry, not a mutable scheduler job or a claim grant.
CREATE TABLE cinatoken_gateway.request_usage_settlement_outbox (
  request_id text PRIMARY KEY,
  payload_sha256 text NOT NULL,
  created_at_ms bigint NOT NULL,
  CONSTRAINT request_usage_settlement_outbox_event UNIQUE (request_id, payload_sha256, created_at_ms),
  CONSTRAINT request_usage_settlement_outbox_fact FOREIGN KEY (request_id, payload_sha256, created_at_ms)
    REFERENCES cinatoken_gateway.request_usage_settlements(request_id, payload_sha256, created_at_ms)
);
-- AFTER INSERT below creates the outbox before COMMIT. This reciprocal deferred FK also fails
-- closed if the enqueue trigger is accidentally disabled: no accepted undiscoverable snapshot.
ALTER TABLE cinatoken_gateway.request_usage_settlements
  ADD CONSTRAINT request_usage_settlements_require_outbox FOREIGN KEY (request_id, payload_sha256, created_at_ms)
    REFERENCES cinatoken_gateway.request_usage_settlement_outbox(request_id, payload_sha256, created_at_ms)
    DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION cinatoken_gateway.guard_usage_settlement_fact() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $guard$
DECLARE
  envelope_prefix text;
  envelope_suffix text;
  params_json json;
BEGIN
  IF NEW.created_at_ms IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'Settlement persistence time is database-owned'; END IF;
  IF octet_length(NEW.payload_json) NOT BETWEEN 1 AND 262144 THEN RAISE EXCEPTION 'Settlement payload size invalid'; END IF;
  -- Exact framing is part of the shared v1 canonical codec contract (sorted object keys).
  -- Do NOT extract fields from the whole payload using ->/->>/jsonb: PostgreSQL then decodes
  -- Unicode escapes even in unrelated params and rejects valid JSON such as escaped NUL or
  -- lone surrogates. Keep the original bytes, bind every outer identity byte, then validate
  -- the entire remaining params as ONE JSON object without unescaping its string values.
  envelope_prefix := format('{"dispatchClaimId":%s,"intent":{"apiKeyId":%s,"attemptIndex":%s,"contextSha256":%s,"operation":%s,"requestId":%s,"userId":%s,"workspaceId":%s},"params":',
    to_json(NEW.dispatch_claim_id), to_json(NEW.api_key_id), NEW.attempt_index, to_json(NEW.context_sha256),
    to_json(NEW.operation), to_json(NEW.request_id), to_json(NEW.user_id), to_json(NEW.workspace_id));
  envelope_suffix := format(',"recordedAtIso":%s,"version":%s}', to_json(NEW.recorded_at), NEW.payload_version);
  IF length(NEW.payload_json) < length(envelope_prefix) + length(envelope_suffix) + 2
    OR left(NEW.payload_json, length(envelope_prefix)) COLLATE "C" IS DISTINCT FROM envelope_prefix
    OR right(NEW.payload_json, length(envelope_suffix)) COLLATE "C" IS DISTINCT FROM envelope_suffix THEN
    RAISE EXCEPTION 'Settlement payload identity conflict';
  END IF;
  params_json := substr(NEW.payload_json, length(envelope_prefix) + 1,
    length(NEW.payload_json) - length(envelope_prefix) - length(envelope_suffix))::json;
  IF json_typeof(params_json) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Settlement params must be one JSON object'; END IF;
  -- The application codec additionally validates every allowed params field, canonical bytes
  -- and accounting consistency before writes AND on reads. SQL is not a second full DTO codec.
  PERFORM NEW.recorded_at::timestamptz; -- Reject impossible calendar dates without rewriting original text.
  NEW.created_at_ms := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  RETURN NEW;
END;
$guard$;
REVOKE ALL ON FUNCTION cinatoken_gateway.guard_usage_settlement_fact() FROM PUBLIC;
CREATE TRIGGER request_usage_settlements_guard BEFORE INSERT ON cinatoken_gateway.request_usage_settlements
  FOR EACH ROW EXECUTE FUNCTION cinatoken_gateway.guard_usage_settlement_fact();

CREATE FUNCTION cinatoken_gateway.enqueue_usage_settlement_fact() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $enqueue$
BEGIN
  INSERT INTO cinatoken_gateway.request_usage_settlement_outbox(request_id, payload_sha256, created_at_ms)
    VALUES (NEW.request_id, NEW.payload_sha256, NEW.created_at_ms);
  RETURN NEW;
END;
$enqueue$;
REVOKE ALL ON FUNCTION cinatoken_gateway.enqueue_usage_settlement_fact() FROM PUBLIC;
CREATE TRIGGER request_usage_settlements_enqueue AFTER INSERT ON cinatoken_gateway.request_usage_settlements
  FOR EACH ROW EXECUTE FUNCTION cinatoken_gateway.enqueue_usage_settlement_fact();

CREATE FUNCTION cinatoken_gateway.reject_usage_settlement_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $immutable$
BEGIN
  RAISE EXCEPTION 'Settlement fact and discovery entry are immutable';
END;
$immutable$;
REVOKE ALL ON FUNCTION cinatoken_gateway.reject_usage_settlement_mutation() FROM PUBLIC;
CREATE TRIGGER request_usage_settlements_immutable BEFORE UPDATE OR DELETE ON cinatoken_gateway.request_usage_settlements
  FOR EACH ROW EXECUTE FUNCTION cinatoken_gateway.reject_usage_settlement_mutation();
CREATE TRIGGER request_usage_settlement_outbox_immutable BEFORE UPDATE OR DELETE ON cinatoken_gateway.request_usage_settlement_outbox
  FOR EACH ROW EXECUTE FUNCTION cinatoken_gateway.reject_usage_settlement_mutation();

-- No backfill, automatic migration, grants, financial receipts or delete/retention procedure.
-- Roles must prohibit DDL/TRUNCATE/trigger disabling; production permissions and upgrade locks remain C03 gates.
DO $recovery_runtime_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_runtime') THEN
    EXECUTE 'REVOKE ALL ON TABLE cinatoken_gateway.request_usage_settlements, cinatoken_gateway.request_usage_settlement_outbox FROM cinatoken_gateway_runtime';
  END IF;
END;
$recovery_runtime_acl$;
