// Review-only source freeze. Generate the static v348 SQL from pinned v347/v341/v344 bodies.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const proposal = new URL('../../../packages/core/migrations-proposals/postgres/', import.meta.url);
const files = {
  producer: 'shared-key-economic-producer-buyer-login-v347.sql',
  debit: 'shared-key-buyer-debit-v2.sql',
  receipt: 'shared-key-buyer-budget-receipt-v2.sql',
};
const text = {};
for (const [key, name] of Object.entries(files)) {
  text[key] = (await readFile(new URL(name, proposal), 'utf8')).replace(/\r\n/gu, '\n');
}
const md5 = value => createHash('md5').update(value).digest('hex');
const takeFunction = (source, name, tag) => {
  const header = source.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`) !== -1
    ? source.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`)
    : source.indexOf(`CREATE FUNCTION ${name}(`);
  assert.ok(header !== -1, `missing ${name}`);
  const start = header + 7;
  const end = source.indexOf(`$${tag}$;`, start);
  assert.ok(header !== -1 && end !== -1, `unterminated ${name}`);
  const definition = source.slice(header, end + tag.length + 3);
  const marker = `AS $${tag}$`;
  const bodyStart = definition.indexOf(marker);
  assert.ok(bodyStart !== -1);
  return { definition, body: definition.slice(bodyStart + marker.length, -tag.length - 3) };
};
const source = {
  producer: takeFunction(text.producer,
    'cinatoken_economic_outbox.write_shared_key_economic_event_v2', 'producer'),
  debit: takeFunction(text.debit,
    'cinatoken_economic_outbox.verify_buyer_debit_v2', 'verify'),
  receipt: takeFunction(text.receipt,
    'cinatoken_economic_outbox.verify_buyer_budget_tx_receipt', 'verify'),
};
assert.equal(md5(source.producer.body), '132180ac28c093adc3fb07c38a769cab');
assert.equal(md5(source.debit.body), 'f58977880d4f575264a2eb7110902b2b');
const replaceOnce = (input, before, after) => {
  assert.ok(input.includes(before), `missing replacement anchor: ${before.slice(0, 80)}`);
  assert.equal(input.indexOf(before), input.lastIndexOf(before), 'ambiguous replacement anchor');
  return input.replace(before, after);
};
const helper = 'cinatoken_economic_outbox.verified_guardrail_pre_send_denial';
let producer = replaceOnce(source.producer.definition,
  `        OR EXISTS (SELECT 1 FROM cinatoken_gateway.user_budget_reservations\n          WHERE request_id=p_request_log_id)))`,
  `        OR EXISTS (SELECT 1 FROM cinatoken_gateway.user_budget_reservations\n          WHERE request_id=p_request_log_id\n            AND NOT ${helper}(p_request_log_id,buyer.user_id,buyer.api_key_id)))))`);
producer = replaceOnce(producer, 'buyer.api_key_id)))))', 'buyer.api_key_id))))');
producer = replaceOnce(producer, 'DECLARE buyer record;',
  'DECLARE buyer record;\nDECLARE pre_send_denial boolean := false;');
producer = replaceOnce(producer,
  `            AND NOT ${helper}(p_request_log_id,buyer.user_id,buyer.api_key_id))))`,
  `            AND (p_buyer_usage_certainty<>'unknown'
              OR buyer.input_tokens IS DISTINCT FROM 0
              OR buyer.output_tokens IS DISTINCT FROM 0
              OR buyer.cache_read_tokens IS DISTINCT FROM 0
              OR buyer.cache_write_tokens IS DISTINCT FROM 0
              OR NOT ${helper}(p_request_log_id,buyer.user_id,buyer.api_key_id)))))`);
producer = replaceOnce(producer,
  `  SELECT count(*) INTO claimed_count
    FROM cinatoken_economic_quotes.shared_key_dispatch_quote_attempts`,
  `  pre_send_denial := p_buyer_charge_basis='none' AND EXISTS (
    SELECT 1 FROM cinatoken_gateway.user_budget_reservations
      WHERE request_id=p_request_log_id);
  SELECT count(*) INTO claimed_count
    FROM cinatoken_economic_quotes.shared_key_dispatch_quote_attempts`);
producer = replaceOnce(producer,
  `    a_observed := (item->>'observed_at')::timestamptz;
    IF a_id=ANY(seen_ids)`,
  `    a_observed := (item->>'observed_at')::timestamptz;
    IF pre_send_denial AND (a_usage IS DISTINCT FROM 'unknown'
      OR a_cost_certainty IS DISTINCT FROM 'unknown'
      OR a_input IS NOT NULL OR a_output IS NOT NULL
      OR a_cache_read IS NOT NULL OR a_cache_write IS NOT NULL
      OR a_cost IS NOT NULL) THEN
      RAISE EXCEPTION 'Pre-send Guardrail denial cannot claim actual attempt usage'
        USING ERRCODE='23514',CONSTRAINT='shared_key_guardrail_denial_attempt_not_actual';
    END IF;
    IF a_id=ANY(seen_ids)`);
let debit = replaceOnce(source.debit.definition,
  `  IF reservation_found THEN\n    SELECT * INTO marker FROM`,
  `  IF reservation_found AND NOT (NEW.buyer_charge_basis='none'\n    AND ${helper}(NEW.request_log_id,NEW.buyer_user_id,NEW.buyer_api_key_id)) THEN\n    SELECT * INTO marker FROM`);
debit = replaceOnce(debit,
  `    IF reservation_found OR NEW.buyer_debit_micros<>0`,
  `    IF (reservation_found AND NOT\n      ${helper}(NEW.request_log_id,NEW.buyer_user_id,NEW.buyer_api_key_id))\n      OR NEW.buyer_debit_micros<>0`);
let receipt = replaceOnce(source.receipt.definition,
  `COALESCE(pg_catalog.sum(r.reserved_micros) FILTER\n      (WHERE r.request_id IS NOT NULL),0)::numeric`,
  `COALESCE(pg_catalog.sum(r.reserved_micros) FILTER\n      (WHERE r.request_id IS NOT NULL AND e.buyer_charge_basis<>'none'),0)::numeric`);
debit = debit.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION');
receipt = receipt.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION');
assert.ok(producer.startsWith('CREATE OR REPLACE FUNCTION'));
assert.ok(debit.startsWith('CREATE OR REPLACE FUNCTION'));
assert.ok(receipt.startsWith('CREATE OR REPLACE FUNCTION'));
const bodyOf = (definition, tag) => definition.split(`AS $${tag}$`)[1].split(`$${tag}$;`)[0];
const after = { producer: md5(bodyOf(producer, 'producer')),
  debit: md5(bodyOf(debit, 'verify')),
  receipt: md5(bodyOf(receipt, 'verify')) };
const sql = `-- REVIEW ONLY. Post-reservation Guardrail denial bridge after v347 buyer LOGIN.\n-- Direct migrator LOGIN, one transaction, explicit activation; no production grant.\n+SET LOCAL lock_timeout = '2s';\n+SET LOCAL statement_timeout = '15s';\n+SET LOCAL search_path TO pg_catalog, pg_temp;\n+SELECT pg_catalog.pg_advisory_xact_lock(746923553);\n+LOCK TABLE cinatoken_gateway.schema_migrations,\n+  cinatoken_gateway.users,\n+  cinatoken_gateway.user_budget_reservations,\n+  cinatoken_gateway.guardrail_budget_reservations,\n+  cinatoken_gateway.api_key_request_logs,\n+  cinatoken_economic_quotes.shared_key_dispatch_quote_attempts,\n+  cinatoken_economic_outbox.shared_key_economic_events,\n+  cinatoken_economic_outbox.shared_key_buyer_reservation_admissions\n+  IN SHARE ROW EXCLUSIVE MODE;\n+\n+DO $preflight$\n+DECLARE migrator_oid oid; runtime_oid oid; buyer_oid oid;\n+BEGIN\n+  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_migrator';\n+  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_runtime';\n+  SELECT oid INTO buyer_oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_buyer_settlement';\n+  IF pg_catalog.current_setting('cinatoken.shared_key_guardrail_denial_v348_activation',true)\n+      IS DISTINCT FROM 'reviewed-v1'\n+    OR CURRENT_USER<>'cinatoken_gateway_migrator' OR SESSION_USER<>CURRENT_USER\n+    OR migrator_oid IS NULL OR runtime_oid IS NULL OR buyer_oid IS NULL\n+    OR (SELECT pg_catalog.count(*) FROM cinatoken_gateway.schema_migrations)<>73\n+    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\\n'\n+        ORDER BY version COLLATE \"C\")) FROM cinatoken_gateway.schema_migrations)\n+      <>'ca1ea96a1b4bcd0675642f30dcf48042'\n+    OR pg_catalog.has_table_privilege(runtime_oid,\n+      'cinatoken_gateway.user_budget_reservations','UPDATE')\n+    OR NOT pg_catalog.has_table_privilege(buyer_oid,\n+      'cinatoken_gateway.user_budget_reservations','UPDATE')\n+    OR pg_catalog.has_table_privilege(buyer_oid,\n+      'cinatoken_economic_outbox.shared_key_economic_events','INSERT')\n+    OR pg_catalog.has_schema_privilege(buyer_oid,'cinatoken_economic_outbox','CREATE')\n+    OR pg_catalog.to_regclass('cinatoken_economic_outbox.shared_key_guardrail_pre_send_denials') IS NOT NULL\n+    OR pg_catalog.to_regprocedure('${helper}(text,text,text)') IS NOT NULL\n+    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid IN (\n+      'cinatoken_gateway.user_budget_reservations'::pg_catalog.regclass,\n+      'cinatoken_gateway.guardrail_budget_reservations'::pg_catalog.regclass,\n+      'cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass)\n+      AND (c.relowner<>migrator_oid OR c.relkind<>'r' OR c.relrowsecurity OR c.relforcerowsecurity))\n+    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p WHERE p.oid IN (\n+      'cinatoken_economic_outbox.write_shared_key_economic_event_v2(text,text,text,bigint,jsonb,text)'::pg_catalog.regprocedure,\n+      'cinatoken_economic_outbox.verify_buyer_debit_v2()'::pg_catalog.regprocedure,\n+      'cinatoken_economic_outbox.verify_buyer_budget_tx_receipt()'::pg_catalog.regprocedure)\n+      AND p.proowner=migrator_oid AND p.prosecdef AND p.provolatile='v'\n+      AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[]\n+      AND pg_catalog.md5(pg_catalog.replace(p.prosrc,pg_catalog.chr(13)||pg_catalog.chr(10),pg_catalog.chr(10)))=\n+        CASE p.proname\n+          WHEN 'write_shared_key_economic_event_v2' THEN '${md5(source.producer.body)}'\n+          WHEN 'verify_buyer_debit_v2' THEN '${md5(source.debit.body)}'\n+          WHEN 'verify_buyer_budget_tx_receipt' THEN '${md5(source.receipt.body)}'\n+          ELSE '' END)<>3\n+  THEN RAISE EXCEPTION 'Guardrail denial v348 activation or dependency differs'; END IF;\n+END;\n+$preflight$;\n+\n+-- This private receipt is born only on the budget repository's reserved -> released\n+-- transition with its exact Guardrail rejection reason, before any dispatch mark.\n+CREATE TABLE cinatoken_economic_outbox.shared_key_guardrail_pre_send_denials (\n+  request_id text PRIMARY KEY REFERENCES cinatoken_gateway.user_budget_reservations(request_id)\n+    ON UPDATE RESTRICT ON DELETE RESTRICT,\n+  user_id text NOT NULL,\n+  api_key_id text NOT NULL,\n+  reserved_micros bigint NOT NULL CHECK (reserved_micros>0),\n+  release_xact_id xid8 NOT NULL,\n+  released_at timestamptz NOT NULL\n+);\n+CREATE FUNCTION cinatoken_economic_outbox.capture_guardrail_pre_send_denial()\n+RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER\n+SET search_path TO pg_catalog, pg_temp AS $capture$\n+BEGIN\n+  IF TG_RELID<>'cinatoken_gateway.user_budget_reservations'::pg_catalog.regclass\n+    OR TG_NAME<>'user_budget_reservations_capture_guardrail_pre_send_denial'\n+    OR TG_OP<>'UPDATE' OR TG_LEVEL<>'ROW' THEN\n+    RAISE EXCEPTION 'Guardrail denial receipt trigger binding differs';\n+  END IF;\n+  IF SESSION_USER<>'cinatoken_gateway_buyer_settlement'\n+    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'\n+    OR OLD.state<>'reserved' OR NEW.state<>'released'\n+    OR OLD.dispatched_at IS NOT NULL OR NEW.dispatched_at IS NOT NULL\n+    OR OLD.settled_micros<>0 OR NEW.settled_micros<>0\n+    OR NEW.terminal_reason IS DISTINCT FROM 'guardrail_budget_admission_rejected'\n+    OR NEW.terminal_at IS NULL\n+    OR OLD.request_id IS DISTINCT FROM NEW.request_id\n+    OR OLD.user_id IS DISTINCT FROM NEW.user_id\n+    OR OLD.api_key_id IS DISTINCT FROM NEW.api_key_id\n+    OR OLD.reserved_micros IS DISTINCT FROM NEW.reserved_micros\n+    OR NOT EXISTS (SELECT 1 FROM cinatoken_economic_quotes.shared_key_dispatch_quote_attempts\n+      WHERE request_log_id=NEW.request_id)\n+    OR EXISTS (SELECT 1 FROM cinatoken_gateway.guardrail_budget_reservations\n+      WHERE request_id=NEW.request_id) THEN RETURN NULL; END IF;\n+  INSERT INTO cinatoken_economic_outbox.shared_key_guardrail_pre_send_denials\n+    (request_id,user_id,api_key_id,reserved_micros,release_xact_id,released_at)\n+    VALUES (NEW.request_id,NEW.user_id,NEW.api_key_id,NEW.reserved_micros,\n+      pg_catalog.pg_current_xact_id(),NEW.terminal_at);\n+  RETURN NULL;\n+END;\n+$capture$;\n+CREATE TRIGGER user_budget_reservations_capture_guardrail_pre_send_denial\n+  AFTER UPDATE ON cinatoken_gateway.user_budget_reservations\n+  FOR EACH ROW EXECUTE FUNCTION cinatoken_economic_outbox.capture_guardrail_pre_send_denial();\n+\n+CREATE FUNCTION ${helper}(\n+  p_request_id text,p_user_id text,p_api_key_id text)\n+RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER\n+SET search_path TO pg_catalog, pg_temp AS $proof$\n+  SELECT EXISTS (SELECT 1 FROM cinatoken_gateway.user_budget_reservations r\n+    JOIN cinatoken_economic_outbox.shared_key_guardrail_pre_send_denials d\n+      ON d.request_id=r.request_id AND d.user_id=r.user_id\n+      AND d.api_key_id=r.api_key_id AND d.reserved_micros=r.reserved_micros\n+    WHERE r.request_id=p_request_id AND r.user_id=p_user_id\n+      AND r.api_key_id=p_api_key_id AND r.state='released'\n+      AND r.settled_micros=0 AND r.dispatched_at IS NULL\n+      AND r.terminal_reason='guardrail_budget_admission_rejected'\n+      AND r.terminal_at=d.released_at\n+      AND NOT EXISTS (SELECT 1 FROM cinatoken_gateway.guardrail_budget_reservations g\n+        WHERE g.request_id=r.request_id));\n+$proof$;\n+\n+CREATE FUNCTION cinatoken_economic_outbox.guard_guardrail_pre_send_denial()\n+RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER\n+SET search_path TO pg_catalog, pg_temp AS $guard$\n+BEGIN\n+  IF TG_RELID<>'cinatoken_gateway.user_budget_reservations'::pg_catalog.regclass\n+    OR TG_NAME<>'user_budget_reservations_guard_guardrail_pre_send_denial'\n+    OR TG_LEVEL<>'ROW' OR TG_OP NOT IN ('UPDATE','DELETE') THEN\n+    RAISE EXCEPTION 'Guardrail denial reservation guard binding differs';\n+  END IF;\n+  IF EXISTS (SELECT 1 FROM cinatoken_economic_outbox.shared_key_guardrail_pre_send_denials\n+      WHERE request_id=OLD.request_id) AND (TG_OP='DELETE' OR\n+      OLD.request_id IS DISTINCT FROM NEW.request_id OR\n+      OLD.user_id IS DISTINCT FROM NEW.user_id OR\n+      OLD.api_key_id IS DISTINCT FROM NEW.api_key_id OR\n+      OLD.reserved_micros IS DISTINCT FROM NEW.reserved_micros OR\n+      OLD.settled_micros IS DISTINCT FROM NEW.settled_micros OR\n+      OLD.state IS DISTINCT FROM NEW.state OR\n+      OLD.dispatched_at IS DISTINCT FROM NEW.dispatched_at OR\n+      OLD.terminal_at IS DISTINCT FROM NEW.terminal_at OR\n+      OLD.terminal_reason IS DISTINCT FROM NEW.terminal_reason) THEN\n+    RAISE EXCEPTION 'Guardrail denial proof cannot change'\n+      USING ERRCODE='23514',CONSTRAINT='shared_key_guardrail_denial_immutable';\n+  END IF;\n+  IF TG_OP='DELETE' THEN RETURN OLD; END IF;\n+  RETURN NEW;\n+END;\n+$guard$;\n+CREATE TRIGGER user_budget_reservations_guard_guardrail_pre_send_denial\n+  BEFORE UPDATE OR DELETE ON cinatoken_gateway.user_budget_reservations\n+  FOR EACH ROW EXECUTE FUNCTION cinatoken_economic_outbox.guard_guardrail_pre_send_denial();\n+CREATE FUNCTION cinatoken_economic_outbox.reject_guardrail_pre_send_denial_change()\n+RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER\n+SET search_path TO pg_catalog, pg_temp AS $reject$\n+BEGIN\n+  RAISE EXCEPTION 'Guardrail denial receipt is immutable'\n+    USING ERRCODE='23514',CONSTRAINT='shared_key_guardrail_denial_immutable';\n+END;\n+$reject$;\n+CREATE TRIGGER shared_key_guardrail_pre_send_denials_no_change\n+  BEFORE UPDATE OR DELETE ON cinatoken_economic_outbox.shared_key_guardrail_pre_send_denials\n+  FOR EACH ROW EXECUTE FUNCTION cinatoken_economic_outbox.reject_guardrail_pre_send_denial_change();\n+\n+-- All three old validators remain exact copies except their narrow released/0 proof branch.\n+${producer}\n+${debit}\n+${receipt}\n+REVOKE ALL ON TABLE cinatoken_economic_outbox.shared_key_guardrail_pre_send_denials\n+  FROM PUBLIC,cinatoken_gateway_runtime,cinatoken_gateway_buyer_settlement;\n+REVOKE ALL ON FUNCTION\n+  cinatoken_economic_outbox.capture_guardrail_pre_send_denial(),\n+  ${helper}(text,text,text),\n+  cinatoken_economic_outbox.guard_guardrail_pre_send_denial(),\n+  cinatoken_economic_outbox.reject_guardrail_pre_send_denial_change()\n+  FROM PUBLIC,cinatoken_gateway_runtime,cinatoken_gateway_buyer_settlement;\n+\n+DO $postflight$\n+DECLARE migrator_oid oid; runtime_oid oid; buyer_oid oid;\n+BEGIN\n+  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_migrator';\n+  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_runtime';\n+  SELECT oid INTO buyer_oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_buyer_settlement';\n+  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p WHERE p.oid IN (\n+    'cinatoken_economic_outbox.write_shared_key_economic_event_v2(text,text,text,bigint,jsonb,text)'::pg_catalog.regprocedure,\n+    'cinatoken_economic_outbox.verify_buyer_debit_v2()'::pg_catalog.regprocedure,\n+    'cinatoken_economic_outbox.verify_buyer_budget_tx_receipt()'::pg_catalog.regprocedure)\n+    AND p.proowner=migrator_oid AND p.prosecdef AND p.provolatile='v'\n+    AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[]\n+    AND pg_catalog.md5(pg_catalog.replace(p.prosrc,pg_catalog.chr(13)||pg_catalog.chr(10),pg_catalog.chr(10)))=\n+      CASE p.proname\n+        WHEN 'write_shared_key_economic_event_v2' THEN '${after.producer}'\n+        WHEN 'verify_buyer_debit_v2' THEN '${after.debit}'\n+        WHEN 'verify_buyer_budget_tx_receipt' THEN '${after.receipt}'\n+        ELSE '' END)<>3\n+    OR NOT pg_catalog.has_function_privilege(buyer_oid,\n+      'cinatoken_economic_outbox.write_shared_key_economic_event_v2(text,text,text,bigint,jsonb,text)','EXECUTE')\n+    OR pg_catalog.has_function_privilege(runtime_oid,\n+      'cinatoken_economic_outbox.write_shared_key_economic_event_v2(text,text,text,bigint,jsonb,text)','EXECUTE')\n+    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c,\n+      LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) acl\n+      WHERE c.oid='cinatoken_economic_outbox.shared_key_guardrail_pre_send_denials'::pg_catalog.regclass\n+        AND (c.relowner<>migrator_oid OR acl.grantee<>migrator_oid))\n+    OR EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgname IN (\n+      'user_budget_reservations_capture_guardrail_pre_send_denial',\n+      'user_budget_reservations_guard_guardrail_pre_send_denial',\n+      'shared_key_guardrail_pre_send_denials_no_change') AND t.tgenabled<>'O')\n+  THEN RAISE EXCEPTION 'Guardrail denial v348 postflight differs'; END IF;\n+END;\n+$postflight$;\n+`;
const guardrailReservationGuard = `-- Serialize Guardrail insertion with the ordinary-release proof for this request.
-- Without the shared advisory key, an uncommitted Guardrail INSERT could be
-- invisible to release and commit after the zero-buyer event.
CREATE FUNCTION cinatoken_economic_outbox.guard_guardrail_reservation_after_denial()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $guard$
BEGIN
  IF TG_RELID<>'cinatoken_gateway.guardrail_budget_reservations'::pg_catalog.regclass
    OR TG_NAME<>'guardrail_budget_reservations_guard_pre_send_denial'
    OR TG_LEVEL<>'ROW' OR TG_OP NOT IN ('INSERT','UPDATE') THEN
    RAISE EXCEPTION 'Guardrail reservation denial guard binding differs';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(348,pg_catalog.hashtext(NEW.request_id));
  IF EXISTS (SELECT 1 FROM cinatoken_economic_outbox.shared_key_guardrail_pre_send_denials
      WHERE request_id=NEW.request_id) THEN
    RAISE EXCEPTION 'Guardrail reservation cannot follow pre-send denial proof'
      USING ERRCODE='23514',CONSTRAINT='shared_key_guardrail_denial_guardrail_late';
  END IF;
  RETURN NEW;
END;
$guard$;
CREATE TRIGGER guardrail_budget_reservations_guard_pre_send_denial
  BEFORE INSERT OR UPDATE ON cinatoken_gateway.guardrail_budget_reservations
  FOR EACH ROW EXECUTE FUNCTION
    cinatoken_economic_outbox.guard_guardrail_reservation_after_denial();
REVOKE ALL ON FUNCTION
  cinatoken_economic_outbox.guard_guardrail_reservation_after_denial()
  FROM PUBLIC,cinatoken_gateway_runtime,cinatoken_gateway_buyer_settlement;

`;
const generated = sql.replace(/^\+/gmu, '').replace(
  "NOT pg_catalog.has_table_privilege(buyer_oid,\n      'cinatoken_gateway.user_budget_reservations','UPDATE')",
  "NOT pg_catalog.has_column_privilege(buyer_oid,\n      'cinatoken_gateway.user_budget_reservations','state','UPDATE')");
const withReleaseLock = replaceOnce(generated,
  "  IF SESSION_USER<>'cinatoken_gateway_buyer_settlement'\n    OR pg_catalog.current_setting('transaction_isolation')",
  "  IF OLD.state='reserved' AND NEW.state='released' THEN\n    PERFORM pg_catalog.pg_advisory_xact_lock(348,pg_catalog.hashtext(NEW.request_id));\n  END IF;\n  IF SESSION_USER<>'cinatoken_gateway_buyer_settlement'\n    OR pg_catalog.current_setting('transaction_isolation')");
const withGuard = replaceOnce(withReleaseLock, 'DO $postflight$',
  `${guardrailReservationGuard}DO $postflight$`);
const withPostflight = replaceOnce(withGuard,
  `    OR EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgname IN (
      'user_budget_reservations_capture_guardrail_pre_send_denial',
      'user_budget_reservations_guard_guardrail_pre_send_denial',
      'shared_key_guardrail_pre_send_denials_no_change') AND t.tgenabled<>'O')`,
  `    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t WHERE
      NOT t.tgisinternal AND t.tgenabled='O' AND (
        (t.tgname='user_budget_reservations_capture_guardrail_pre_send_denial'
          AND t.tgrelid='cinatoken_gateway.user_budget_reservations'::pg_catalog.regclass
          AND t.tgfoid='cinatoken_economic_outbox.capture_guardrail_pre_send_denial()'::pg_catalog.regprocedure
          AND t.tgtype=17)
        OR (t.tgname='user_budget_reservations_guard_guardrail_pre_send_denial'
          AND t.tgrelid='cinatoken_gateway.user_budget_reservations'::pg_catalog.regclass
          AND t.tgfoid='cinatoken_economic_outbox.guard_guardrail_pre_send_denial()'::pg_catalog.regprocedure
          AND t.tgtype=27)
        OR (t.tgname='shared_key_guardrail_pre_send_denials_no_change'
          AND t.tgrelid='cinatoken_economic_outbox.shared_key_guardrail_pre_send_denials'::pg_catalog.regclass
          AND t.tgfoid='cinatoken_economic_outbox.reject_guardrail_pre_send_denial_change()'::pg_catalog.regprocedure
          AND t.tgtype=27)
        OR (t.tgname='guardrail_budget_reservations_guard_pre_send_denial'
          AND t.tgrelid='cinatoken_gateway.guardrail_budget_reservations'::pg_catalog.regclass
          AND t.tgfoid='cinatoken_economic_outbox.guard_guardrail_reservation_after_denial()'::pg_catalog.regprocedure
          AND t.tgtype=23)))<>4`);
await writeFile(new URL('shared-key-guardrail-post-reservation-denial-v348.sql', proposal),
  withPostflight);
process.stdout.write(JSON.stringify({ before: Object.fromEntries(Object.entries(source)
  .map(([name, item]) => [name, md5(item.body)])), after }) + '\n');
