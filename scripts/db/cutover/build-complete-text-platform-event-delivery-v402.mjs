import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CATALOG_QUERY_V400, catalogDigestV400 } from './build-complete-text-auth-routing-recovery-coinstall-v400.mjs';

const root = new URL('../../../', import.meta.url);
const owner = 'cinatoken_gateway_migrator';
export const PUBLISHER_ROLE_V402 = 'cinatoken_gateway_complete_text_platform_event_publisher';
export const CONSUMER_ROLE_V402 = 'cinatoken_gateway_complete_text_platform_event_consumer';
export const BASELINE_RAW_SHA256_V402 = '4647045c0e80b382594cb2b051de4e4dbf03b0ba25a8f146c5cd623be3148554';
export const BASELINE_CANONICAL_SHA256_V402 = '17c93eccf2c9ee78092f63038b29e8b193de18200780fa33450b748ad4c6165d';
const deliveryIndexesQuery = `SELECT COALESCE(jsonb_agg(jsonb_build_object('table_name',x.name,'indexes',x.indexes)
 ORDER BY x.name COLLATE "C"),'[]'::jsonb) FROM (
 SELECT c.oid::regclass::text AS name,jsonb_agg(jsonb_build_object('name',ic.relname,
  'unique',i.indisunique,'primary',i.indisprimary,'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive,
  'definition',pg_get_indexdef(i.indexrelid)) ORDER BY ic.relname COLLATE "C") AS indexes
 FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_class ic ON ic.oid=i.indexrelid
 JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='cinatoken_platform_delivery'
 GROUP BY c.oid) x`;
export const CATALOG_QUERY_V402 = CATALOG_QUERY_V400.replace(/\) AS catalog$/u,
  `,'delivery_indexes',(${deliveryIndexesQuery})) AS catalog`);
export async function captureCatalogV402(sql) {
  return await sql.begin(async tx => {
    await tx.unsafe('SET LOCAL search_path TO pg_catalog,pg_temp');
    const rows=await tx.unsafe(CATALOG_QUERY_V402);
    if(rows.length!==1||!rows[0].catalog)throw new Error('v402 catalog capture differs');
    return rows[0].catalog;
  });
}
const sha = value => createHash('sha256').update(value).digest('hex');
const md5 = value => createHash('md5').update(value.replaceAll('\r\n', '\n')).digest('hex');
const compare = (a,b) => a<b ? -1 : a>b ? 1 : 0;
const order = (rows,key) => [...rows].sort((a,b)=>compare(key(a),key(b)));
const grant = (grantee, privilege) => ({grantee, grantor: owner, privilege, grantable: false});
const roles = [PUBLISHER_ROLE_V402, CONSUMER_ROLE_V402];
const freshRole = name => ({name, login: true, super: false, config: null, inherit: false,
  bypass_rls: false, create_role: false, memberships: [], replication: false,
  public_create: false, create_database: false, database_create: false, connection_limit: -1});

// New objects only. No historical body, source trigger, financial row or default ACL is changed.
export const ACTIONS_SQL_V402 = String.raw`
CREATE SCHEMA cinatoken_platform_delivery AUTHORIZATION cinatoken_gateway_migrator;
REVOKE ALL ON SCHEMA cinatoken_platform_delivery FROM PUBLIC;
CREATE TABLE cinatoken_platform_delivery.jobs_v402 (
 event_id uuid PRIMARY KEY REFERENCES cinatoken_gateway.complete_text_platform_outbox_v388(event_id),
 status text NOT NULL CHECK(status IN('pending','publishing','published','delivered','dead_letter')),
 attempt_count integer NOT NULL CHECK(attempt_count BETWEEN 0 AND 7),
 restore_count integer NOT NULL CHECK(restore_count BETWEEN 0 AND 3),
 next_attempt_at timestamptz NOT NULL,
 lease_nonce uuid,
 lease_until timestamptz,
 delivered_at timestamptz,
 dead_at timestamptz,
 writer_xid xid8 NOT NULL,
 CONSTRAINT jobs_v402_state CHECK(
  (status='pending' AND lease_nonce IS NULL AND lease_until IS NULL AND delivered_at IS NULL AND dead_at IS NULL)
  OR (status IN('publishing','published') AND attempt_count>=1 AND lease_nonce IS NOT NULL AND lease_until IS NOT NULL
   AND next_attempt_at=lease_until AND delivered_at IS NULL AND dead_at IS NULL)
  OR (status='delivered' AND lease_nonce IS NULL AND lease_until IS NULL AND delivered_at IS NOT NULL AND dead_at IS NULL)
  OR (status='dead_letter' AND lease_nonce IS NULL AND lease_until IS NULL AND delivered_at IS NULL AND dead_at IS NOT NULL))
);
CREATE INDEX jobs_v402_due ON cinatoken_platform_delivery.jobs_v402(next_attempt_at,event_id)
 WHERE status IN('pending','publishing','published');
CREATE TABLE cinatoken_platform_delivery.batches_v402 (
 lease_nonce uuid PRIMARY KEY,
 requested_limit integer NOT NULL CHECK(requested_limit BETWEEN 1 AND 20),
 items jsonb NOT NULL CHECK(jsonb_typeof(items)='array' AND jsonb_array_length(items)<=20),
 created_at timestamptz NOT NULL,
 writer_xid xid8 NOT NULL
);
CREATE TABLE cinatoken_platform_delivery.projections_v402 (
 event_id uuid PRIMARY KEY REFERENCES cinatoken_gateway.complete_text_platform_outbox_v388(event_id),
 terminal_id uuid NOT NULL UNIQUE,
 request_id text NOT NULL UNIQUE,
 event_type text NOT NULL CHECK(event_type='platform_text_no_fetch_closed'),
 event_version integer NOT NULL CHECK(event_version=1),
 payload_sha256 text NOT NULL CHECK(payload_sha256 ~ '^[0-9a-f]{64}$'),
 projection jsonb NOT NULL,
 projection_sha256 text NOT NULL CHECK(projection_sha256 ~ '^[0-9a-f]{64}$'),
 consumed_at timestamptz NOT NULL,
 writer_xid xid8 NOT NULL
);
CREATE TABLE cinatoken_platform_delivery.receipts_v402 (
 event_id uuid PRIMARY KEY REFERENCES cinatoken_platform_delivery.projections_v402(event_id),
 projection_sha256 text NOT NULL CHECK(projection_sha256 ~ '^[0-9a-f]{64}$'),
 consumed_at timestamptz NOT NULL,
 writer_xid xid8 NOT NULL
);
CREATE TABLE cinatoken_platform_delivery.restores_v402 (
 event_id uuid NOT NULL REFERENCES cinatoken_platform_delivery.jobs_v402(event_id),
 restore_count integer NOT NULL CHECK(restore_count BETWEEN 1 AND 3),
 reason text NOT NULL CHECK(octet_length(convert_to(reason,'UTF8')) BETWEEN 1 AND 256 AND reason=btrim(reason)
  AND reason !~ '[[:cntrl:]]'),
 restored_at timestamptz NOT NULL,
 writer_xid xid8 NOT NULL,
 PRIMARY KEY(event_id,restore_count)
);

CREATE FUNCTION cinatoken_platform_delivery.require_actor_v402(p_roles text[])
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO pg_catalog,pg_temp AS $actor$
BEGIN
 IF (SESSION_USER=ANY(p_roles)) IS NOT TRUE OR current_setting('role')<>'none'
  OR current_setting('transaction_isolation')<>'read committed'
  OR current_setting('session_replication_role')<>'origin'
 THEN RAISE EXCEPTION 'v402 direct actor and read committed required' USING ERRCODE='42501'; END IF;
END;
$actor$;

CREATE FUNCTION cinatoken_platform_delivery.read_source_v402(p_event_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO pg_catalog,pg_temp AS $source$
DECLARE e cinatoken_gateway.complete_text_platform_outbox_v388%ROWTYPE;
 t cinatoken_gateway.complete_text_platform_terminals_v388%ROWTYPE;
 g cinatoken_gateway.complete_text_attempt_grants_v362%ROWTYPE;
 q cinatoken_gateway.complete_text_quotes_v360%ROWTYPE;
 r cinatoken_gateway.complete_text_no_fetch_resolutions_v370%ROWTYPE;
 a cinatoken_gateway.complete_text_admissions_v361%ROWTYPE;
 current_image jsonb; expected_image jsonb; item jsonb; fact jsonb; row_key text; typed_rows jsonb; expected_log_image jsonb;
BEGIN
 -- Source snapshots were rendered in the original closer session. Normalize typed
 -- timestamp fields before comparing, and make the historical projection hash UTC.
 PERFORM pg_catalog.set_config('TimeZone','UTC',true);
 SELECT * INTO e FROM cinatoken_gateway.complete_text_platform_outbox_v388 WHERE event_id=p_event_id;
 IF e.event_id IS NULL THEN RAISE EXCEPTION 'v402 event missing' USING ERRCODE='P0002'; END IF;
 SELECT * INTO t FROM cinatoken_gateway.complete_text_platform_terminals_v388 WHERE terminal_id=e.terminal_id;
 SELECT * INTO g FROM cinatoken_gateway.complete_text_attempt_grants_v362 WHERE grant_id=t.grant_id;
 SELECT * INTO q FROM cinatoken_gateway.complete_text_quotes_v360 WHERE quote_id=t.quote_id;
 SELECT * INTO r FROM cinatoken_gateway.complete_text_no_fetch_resolutions_v370 WHERE resolution_id=t.resolution_id;
 SELECT * INTO a FROM cinatoken_gateway.complete_text_admissions_v361 WHERE request_id=t.request_id;
 SELECT jsonb_object_agg(key,value) INTO expected_log_image FROM jsonb_each(
  to_jsonb(jsonb_populate_record(NULL::cinatoken_gateway.api_key_request_logs,t.expected_log)))
  WHERE t.expected_log ? key;
 typed_rows:=jsonb_build_object('grant',to_jsonb(g),'quote',to_jsonb(q),'noFetchResolution',to_jsonb(r));
 FOREACH row_key IN ARRAY ARRAY['grant','quote','noFetchResolution'] LOOP
  IF jsonb_typeof(e.payload->row_key) IS DISTINCT FROM 'object'
   OR (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(e.payload->row_key) k)
    IS DISTINCT FROM (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(typed_rows->row_key) k)
  THEN RAISE EXCEPTION 'v402 historical source shape differs' USING ERRCODE='23514'; END IF;
 END LOOP;
 expected_image:=jsonb_build_object('eventType','platform_text_no_fetch_closed','eventVersion',1,
  'terminalId',t.terminal_id,'eventId',e.event_id,'requestId',t.request_id,'quoteId',q.quote_id,
  'grantId',g.grant_id,'resolutionId',r.resolution_id,'decisionNonce',t.decision_nonce,
  'result','verified_no_fetch','buyerChargedMicros',0,'buyerBillableUnits',0,'supplierCostStatus','not_asserted',
  'supplierCostMicros',NULL,'grant',e.payload->'grant','noFetchResolution',e.payload->'noFetchResolution','quote',e.payload->'quote',
  'selectedFacts',e.payload->'selectedFacts','closedAt',e.payload->'closedAt');
 IF t.terminal_id IS NULL OR g.grant_id IS NULL OR q.quote_id IS NULL OR r.resolution_id IS NULL OR a.request_id IS NULL
  OR e.event_type<>'platform_text_no_fetch_closed' OR e.event_version<>1
  OR e.request_id<>t.request_id OR e.event_id<>t.event_id OR e.created_at<>t.closed_at OR e.writer_xid<>t.writer_xid
  OR e.payload IS DISTINCT FROM t.decision OR e.payload IS DISTINCT FROM expected_image OR e.payload_sha256<>t.decision_sha256
  OR e.payload_sha256<>encode(sha256(convert_to(e.payload::text,'UTF8')),'hex')
  OR t.buyer_charged_micros<>0 OR t.supplier_cost_status<>'not_asserted' OR t.supplier_cost_micros IS NOT NULL
  OR g.request_id<>t.request_id OR g.quote_id<>t.quote_id OR q.request_id<>t.request_id
  OR r.grant_id<>g.grant_id OR r.request_id<>t.request_id OR r.quote_id<>q.quote_id OR r.result<>'verified_no_fetch'
  OR a.quote_id<>q.quote_id OR a.reserved_micros<>q.three_attempt_ceiling_micros
  OR (SELECT count(*) FROM cinatoken_gateway.complete_text_attempt_grants_v362 WHERE request_id=t.request_id)<>1
  OR EXISTS(SELECT 1 FROM cinatoken_gateway.complete_text_send_starts_v365 WHERE request_id=t.request_id)
  OR EXISTS(SELECT 1 FROM cinatoken_response_observation.observations_v392 WHERE grant_id=g.grant_id)
  OR EXISTS(SELECT 1 FROM cinatoken_gateway.complete_text_result_facts_v366 WHERE grant_id=g.grant_id
    AND kind IN('fetch_invoked','transport_unknown','provider_usage','provider_zero_charge_observation'))
  OR e.payload->>'eventType'<>'platform_text_no_fetch_closed' OR (e.payload->>'eventVersion')::integer<>1
  OR e.payload->>'terminalId'<>t.terminal_id::text OR e.payload->>'eventId'<>e.event_id::text
  OR e.payload->>'requestId'<>t.request_id OR e.payload->>'quoteId'<>q.quote_id::text
  OR e.payload->>'grantId'<>g.grant_id::text OR e.payload->>'resolutionId'<>r.resolution_id::text
  OR e.payload->>'decisionNonce'<>t.decision_nonce::text OR e.payload->>'result'<>'verified_no_fetch'
  OR (e.payload->>'buyerChargedMicros')::numeric<>0 OR (e.payload->>'buyerBillableUnits')::numeric<>0
  OR e.payload->>'supplierCostStatus'<>'not_asserted' OR e.payload->'supplierCostMicros'<>'null'::jsonb
  OR (e.payload->>'closedAt')::timestamptz<>t.closed_at
  OR to_jsonb(jsonb_populate_record(NULL::cinatoken_gateway.complete_text_attempt_grants_v362,e.payload->'grant')) IS DISTINCT FROM to_jsonb(g)
  OR to_jsonb(jsonb_populate_record(NULL::cinatoken_gateway.complete_text_quotes_v360,e.payload->'quote')) IS DISTINCT FROM to_jsonb(q)
  OR to_jsonb(jsonb_populate_record(NULL::cinatoken_gateway.complete_text_no_fetch_resolutions_v370,e.payload->'noFetchResolution')) IS DISTINCT FROM to_jsonb(r)
  OR NOT EXISTS(SELECT 1 FROM cinatoken_gateway.api_key_request_logs l
    WHERE l.id=t.request_id AND to_jsonb(l) @> expected_log_image
     AND l.budget_charged_micros=0 AND l.charged_cost=0 AND l.standard_cost=0 AND l.metered_cost=0)
 THEN RAISE EXCEPTION 'v402 immutable event source differs' USING ERRCODE='23514',CONSTRAINT='platform_delivery_source_v402'; END IF;
 SELECT to_jsonb(h) INTO current_image FROM cinatoken_gateway.user_budget_reservations h WHERE request_id=t.request_id;
 IF t.ordinary_before IS NULL THEN
  IF current_image IS NOT NULL THEN RAISE EXCEPTION 'v402 unexpected ordinary hold' USING ERRCODE='23514'; END IF;
 ELSE
  expected_image:=to_jsonb(jsonb_populate_record(NULL::cinatoken_gateway.user_budget_reservations,t.ordinary_before))
   ||jsonb_build_object('state','settled','settled_micros',0,'terminal_at',t.closed_at,
   'terminal_reason','platform_verified_no_fetch_v388','updated_at',t.closed_at);
  IF current_image IS DISTINCT FROM expected_image THEN RAISE EXCEPTION 'v402 ordinary proof differs' USING ERRCODE='23514'; END IF;
 END IF;
 IF jsonb_typeof(t.guardrails_before)<>'array' OR jsonb_array_length(t.guardrails_before)<>a.guardrail_count
  OR (SELECT count(*) FROM cinatoken_gateway.guardrail_budget_reservations WHERE request_id=t.request_id)<>a.guardrail_count
 THEN RAISE EXCEPTION 'v402 Guardrail proof count differs' USING ERRCODE='23514'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(t.guardrails_before) LOOP
  SELECT to_jsonb(h) INTO current_image FROM cinatoken_gateway.guardrail_budget_reservations h WHERE id=item->>'id';
  expected_image:=to_jsonb(jsonb_populate_record(NULL::cinatoken_gateway.guardrail_budget_reservations,item))
   ||jsonb_build_object('state','settled','settled_micros',0,'terminal_at',t.closed_at,
   'terminal_reason','platform_verified_no_fetch_v388','updated_at',t.closed_at);
  IF current_image IS DISTINCT FROM expected_image THEN RAISE EXCEPTION 'v402 Guardrail proof differs' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF jsonb_typeof(e.payload->'selectedFacts')<>'array' THEN RAISE EXCEPTION 'v402 fact proof differs' USING ERRCODE='23514'; END IF;
 FOR fact IN SELECT value FROM jsonb_array_elements(e.payload->'selectedFacts') LOOP
  IF NOT EXISTS(SELECT 1 FROM cinatoken_gateway.complete_text_result_facts_v366 f
   WHERE f.grant_id=g.grant_id AND f.fact_id=(fact->>'factId')::uuid AND f.evidence_sha256=fact->>'evidenceSha256')
  THEN RAISE EXCEPTION 'v402 selected fact differs' USING ERRCODE='23514'; END IF;
 END LOOP;
 -- v388 deferred verification attested the original counter deltas. Current account/window
 -- balances may lawfully change or reset; history is validated from immutable holds and witness.
 RETURN jsonb_build_object('eventId',e.event_id,'terminalId',t.terminal_id,'requestId',t.request_id,
  'eventType',e.event_type,'eventVersion',e.event_version,'payloadSha256',e.payload_sha256,
  'buyerChargedMicros',0,'supplierCostStatus','not_asserted','supplierCostMicros',NULL,
  'sourceWriterXid',e.writer_xid::text,'closedAt',t.closed_at);
END;
$source$;

CREATE FUNCTION cinatoken_platform_delivery.protect_rows_v402()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO pg_catalog,pg_temp AS $rows$
DECLARE item jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'v402 metadata is append only' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='batches_v402' THEN PERFORM cinatoken_platform_delivery.require_actor_v402(ARRAY['cinatoken_gateway_complete_text_platform_event_publisher']);
 ELSIF TG_TABLE_NAME IN('projections_v402','receipts_v402') THEN
  PERFORM cinatoken_platform_delivery.require_actor_v402(ARRAY['cinatoken_gateway_complete_text_platform_event_consumer']);
 ELSIF TG_TABLE_NAME='restores_v402' THEN PERFORM cinatoken_platform_delivery.require_actor_v402(ARRAY['cinatoken_gateway_migrator']);
 ELSE RAISE EXCEPTION 'v402 unexpected metadata relation' USING ERRCODE='23514'; END IF;
 IF NEW.writer_xid<>pg_current_xact_id() THEN RAISE EXCEPTION 'v402 writer witness differs' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='batches_v402' THEN
  IF (SELECT count(DISTINCT value->>'eventId') FROM jsonb_array_elements(NEW.items))<>jsonb_array_length(NEW.items)
  THEN RAISE EXCEPTION 'v402 duplicate batch event' USING ERRCODE='23514'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(NEW.items) LOOP
   IF (item-ARRAY['eventId','attemptCount','leaseUntil'])<>'{}'::jsonb OR NOT EXISTS(
    SELECT 1 FROM cinatoken_platform_delivery.jobs_v402 j WHERE j.event_id=(item->>'eventId')::uuid
     AND j.status='publishing' AND j.lease_nonce=NEW.lease_nonce AND j.attempt_count=(item->>'attemptCount')::integer
     AND j.lease_until=(item->>'leaseUntil')::timestamptz AND j.writer_xid=NEW.writer_xid)
   THEN RAISE EXCEPTION 'v402 batch job witness differs' USING ERRCODE='23514'; END IF;
  END LOOP;
 END IF;
 RETURN NEW;
END;
$rows$;

CREATE FUNCTION cinatoken_platform_delivery.protect_jobs_v402()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO pg_catalog,pg_temp AS $jobs$
DECLARE publisher boolean:=SESSION_USER='cinatoken_gateway_complete_text_platform_event_publisher';
 consumer boolean:=SESSION_USER='cinatoken_gateway_complete_text_platform_event_consumer';
 operator boolean:=SESSION_USER='cinatoken_gateway_migrator';
BEGIN
 PERFORM cinatoken_platform_delivery.require_actor_v402(ARRAY['cinatoken_gateway_complete_text_platform_event_publisher',
  'cinatoken_gateway_complete_text_platform_event_consumer','cinatoken_gateway_migrator']);
 IF TG_OP NOT IN('INSERT','UPDATE') OR NEW.writer_xid<>pg_current_xact_id()
 THEN RAISE EXCEPTION 'v402 job mutation rejected' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NOT publisher OR NEW.attempt_count<>0 OR NEW.restore_count<>0 OR NEW.status NOT IN('pending','delivered')
  THEN RAISE EXCEPTION 'v402 job enrollment differs' USING ERRCODE='23514'; END IF;
 ELSE
  IF NEW.event_id<>OLD.event_id OR OLD.status='delivered'
  THEN RAISE EXCEPTION 'v402 job identity or terminal mutation' USING ERRCODE='23514'; END IF;
  IF consumer THEN
   IF NEW.status<>'delivered' OR NEW.attempt_count<>OLD.attempt_count OR NEW.restore_count<>OLD.restore_count
    OR (to_jsonb(NEW)-ARRAY['status','lease_nonce','lease_until','delivered_at','dead_at','next_attempt_at','writer_xid'])
     IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','lease_nonce','lease_until','delivered_at','dead_at','next_attempt_at','writer_xid'])
   THEN RAISE EXCEPTION 'v402 consumer job transition differs' USING ERRCODE='23514'; END IF;
  ELSIF operator THEN
   IF OLD.status<>'dead_letter' OR NEW.status<>'pending' OR NEW.attempt_count<>0
    OR NEW.restore_count<>OLD.restore_count+1
    OR (to_jsonb(NEW)-ARRAY['status','attempt_count','restore_count','next_attempt_at','lease_nonce','lease_until','dead_at','writer_xid'])
     IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','attempt_count','restore_count','next_attempt_at','lease_nonce','lease_until','dead_at','writer_xid'])
   THEN RAISE EXCEPTION 'v402 operator job transition differs' USING ERRCODE='23514'; END IF;
  ELSIF publisher THEN
   IF NEW.restore_count<>OLD.restore_count
    OR (to_jsonb(NEW)-ARRAY['status','attempt_count','next_attempt_at','lease_nonce','lease_until','dead_at','writer_xid'])
     IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','attempt_count','next_attempt_at','lease_nonce','lease_until','dead_at','writer_xid'])
    OR NOT (
     (NEW.status='publishing' AND OLD.status IN('pending','publishing','published') AND OLD.next_attempt_at<=clock_timestamp()
       AND OLD.attempt_count<7 AND NEW.attempt_count=OLD.attempt_count+1)
     OR (NEW.status='published' AND OLD.status='publishing' AND NEW.lease_nonce=OLD.lease_nonce AND OLD.lease_until>clock_timestamp()
       AND NEW.attempt_count=OLD.attempt_count)
     OR (NEW.status IN('pending','dead_letter') AND OLD.status IN('publishing','published') AND NEW.attempt_count=OLD.attempt_count)
     OR (NEW.status='dead_letter' AND OLD.status='pending' AND OLD.attempt_count=7 AND NEW.attempt_count=7))
   THEN RAISE EXCEPTION 'v402 publisher job transition differs' USING ERRCODE='23514'; END IF;
  ELSE RAISE EXCEPTION 'v402 job actor differs' USING ERRCODE='42501'; END IF;
 END IF;
 RETURN NEW;
END;
$jobs$;

CREATE FUNCTION cinatoken_platform_delivery.verify_companions_v402()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO pg_catalog,pg_temp AS $companion$
DECLARE p cinatoken_platform_delivery.projections_v402%ROWTYPE;
 r cinatoken_platform_delivery.receipts_v402%ROWTYPE;
 j cinatoken_platform_delivery.jobs_v402%ROWTYPE; source jsonb;
BEGIN
 SELECT * INTO p FROM cinatoken_platform_delivery.projections_v402 WHERE event_id=NEW.event_id;
 SELECT * INTO r FROM cinatoken_platform_delivery.receipts_v402 WHERE event_id=NEW.event_id;
 SELECT * INTO j FROM cinatoken_platform_delivery.jobs_v402 WHERE event_id=NEW.event_id;
 IF p.event_id IS NOT NULL OR r.event_id IS NOT NULL THEN
  source:=cinatoken_platform_delivery.read_source_v402(NEW.event_id);
  IF p.event_id IS NULL OR r.event_id IS NULL OR p.projection IS DISTINCT FROM source
   OR p.terminal_id::text<>source->>'terminalId' OR p.request_id<>source->>'requestId'
   OR p.event_type<>source->>'eventType' OR p.event_version<>(source->>'eventVersion')::integer
   OR p.payload_sha256<>source->>'payloadSha256'
   OR p.projection_sha256<>encode(sha256(convert_to(p.projection::text,'UTF8')),'hex')
   OR r.projection_sha256<>p.projection_sha256 OR r.consumed_at<>p.consumed_at OR r.writer_xid<>p.writer_xid
   OR (j.event_id IS NOT NULL AND (j.status<>'delivered' OR j.delivered_at<>r.consumed_at))
  THEN RAISE EXCEPTION 'v402 receipt/projection/job incomplete' USING ERRCODE='23514',CONSTRAINT='platform_delivery_companion_v402'; END IF;
 ELSIF j.status='delivered' THEN
  RAISE EXCEPTION 'v402 delivered job missing receipt' USING ERRCODE='23514',CONSTRAINT='platform_delivery_companion_v402';
 END IF;
 IF j.event_id IS NOT NULL AND j.restore_count<>(SELECT count(*) FROM cinatoken_platform_delivery.restores_v402 WHERE event_id=j.event_id)
 THEN RAISE EXCEPTION 'v402 restoration history incomplete' USING ERRCODE='23514'; END IF;
 IF j.status IN('publishing','published') AND NOT EXISTS(SELECT 1 FROM cinatoken_platform_delivery.batches_v402 b,
  LATERAL jsonb_array_elements(b.items) x WHERE b.lease_nonce=j.lease_nonce AND (x->>'eventId')::uuid=j.event_id
   AND (x->>'attemptCount')::integer=j.attempt_count AND (j.status='published' OR (x->>'leaseUntil')::timestamptz=j.lease_until))
 THEN RAISE EXCEPTION 'v402 leased job missing batch witness' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END;
$companion$;

CREATE TRIGGER jobs_v402_guard BEFORE INSERT OR DELETE OR UPDATE ON cinatoken_platform_delivery.jobs_v402
 FOR EACH ROW EXECUTE FUNCTION cinatoken_platform_delivery.protect_jobs_v402();
CREATE TRIGGER jobs_v402_truncate BEFORE TRUNCATE ON cinatoken_platform_delivery.jobs_v402
 FOR EACH STATEMENT EXECUTE FUNCTION cinatoken_platform_delivery.protect_jobs_v402();
CREATE CONSTRAINT TRIGGER jobs_v402_companion AFTER INSERT OR UPDATE ON cinatoken_platform_delivery.jobs_v402
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cinatoken_platform_delivery.verify_companions_v402();
CREATE TRIGGER batches_v402_guard BEFORE INSERT OR DELETE OR UPDATE ON cinatoken_platform_delivery.batches_v402
 FOR EACH ROW EXECUTE FUNCTION cinatoken_platform_delivery.protect_rows_v402();
CREATE TRIGGER batches_v402_truncate BEFORE TRUNCATE ON cinatoken_platform_delivery.batches_v402
 FOR EACH STATEMENT EXECUTE FUNCTION cinatoken_platform_delivery.protect_rows_v402();
CREATE TRIGGER projections_v402_guard BEFORE INSERT OR DELETE OR UPDATE ON cinatoken_platform_delivery.projections_v402
 FOR EACH ROW EXECUTE FUNCTION cinatoken_platform_delivery.protect_rows_v402();
CREATE TRIGGER projections_v402_truncate BEFORE TRUNCATE ON cinatoken_platform_delivery.projections_v402
 FOR EACH STATEMENT EXECUTE FUNCTION cinatoken_platform_delivery.protect_rows_v402();
CREATE CONSTRAINT TRIGGER projections_v402_companion AFTER INSERT ON cinatoken_platform_delivery.projections_v402
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cinatoken_platform_delivery.verify_companions_v402();
CREATE TRIGGER receipts_v402_guard BEFORE INSERT OR DELETE OR UPDATE ON cinatoken_platform_delivery.receipts_v402
 FOR EACH ROW EXECUTE FUNCTION cinatoken_platform_delivery.protect_rows_v402();
CREATE TRIGGER receipts_v402_truncate BEFORE TRUNCATE ON cinatoken_platform_delivery.receipts_v402
 FOR EACH STATEMENT EXECUTE FUNCTION cinatoken_platform_delivery.protect_rows_v402();
CREATE CONSTRAINT TRIGGER receipts_v402_companion AFTER INSERT ON cinatoken_platform_delivery.receipts_v402
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cinatoken_platform_delivery.verify_companions_v402();
CREATE TRIGGER restores_v402_guard BEFORE INSERT OR DELETE OR UPDATE ON cinatoken_platform_delivery.restores_v402
 FOR EACH ROW EXECUTE FUNCTION cinatoken_platform_delivery.protect_rows_v402();
CREATE TRIGGER restores_v402_truncate BEFORE TRUNCATE ON cinatoken_platform_delivery.restores_v402
 FOR EACH STATEMENT EXECUTE FUNCTION cinatoken_platform_delivery.protect_rows_v402();

CREATE FUNCTION cinatoken_gateway.scan_complete_text_platform_events_v402(p_limit integer)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO pg_catalog,pg_temp
SET lock_timeout TO '2s' SET statement_timeout TO '15s' AS $scan$
DECLARE candidate uuid; receipt cinatoken_platform_delivery.receipts_v402%ROWTYPE; at_time timestamptz; n integer:=0;
BEGIN
 PERFORM cinatoken_platform_delivery.require_actor_v402(ARRAY['cinatoken_gateway_complete_text_platform_event_publisher']);
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'v402 scan limit' USING ERRCODE='22023'; END IF;
 FOR candidate IN SELECT e.event_id FROM cinatoken_gateway.complete_text_platform_outbox_v388 e
  WHERE NOT EXISTS(SELECT 1 FROM cinatoken_platform_delivery.jobs_v402 j WHERE j.event_id=e.event_id)
  ORDER BY e.event_id LIMIT p_limit LOOP
  PERFORM pg_advisory_xact_lock(74692402,hashtext(candidate::text));
  PERFORM cinatoken_platform_delivery.read_source_v402(candidate);
  SELECT * INTO receipt FROM cinatoken_platform_delivery.receipts_v402 WHERE event_id=candidate;
  at_time:=clock_timestamp();
  INSERT INTO cinatoken_platform_delivery.jobs_v402 VALUES(candidate,
   CASE WHEN receipt.event_id IS NULL THEN 'pending' ELSE 'delivered' END,0,0,at_time,NULL,NULL,receipt.consumed_at,NULL,pg_current_xact_id())
   ON CONFLICT(event_id) DO NOTHING;
  IF FOUND THEN n:=n+1; END IF;
 END LOOP;
 RETURN jsonb_build_object('status','scanned','enqueued',n);
END;
$scan$;

CREATE FUNCTION cinatoken_gateway.claim_complete_text_platform_events_v402(p_limit integer,p_lease_nonce uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO pg_catalog,pg_temp
SET lock_timeout TO '2s' SET statement_timeout TO '15s' AS $claim$
DECLARE batch cinatoken_platform_delivery.batches_v402%ROWTYPE;
 job cinatoken_platform_delivery.jobs_v402%ROWTYPE; at_time timestamptz; items jsonb:='[]'::jsonb; live_items jsonb;
BEGIN
 PERFORM cinatoken_platform_delivery.require_actor_v402(ARRAY['cinatoken_gateway_complete_text_platform_event_publisher']);
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 20 OR p_lease_nonce IS NULL
 THEN RAISE EXCEPTION 'v402 claim input' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(74692403,hashtext(p_lease_nonce::text));
 SELECT * INTO batch FROM cinatoken_platform_delivery.batches_v402 WHERE lease_nonce=p_lease_nonce;
 IF batch.lease_nonce IS NOT NULL THEN
  IF batch.requested_limit<>p_limit THEN RAISE EXCEPTION 'v402 nonce limit conflict' USING ERRCODE='22023'; END IF;
  SELECT COALESCE(jsonb_agg(x.value ORDER BY x.ordinality),'[]'::jsonb) INTO live_items
   FROM jsonb_array_elements(batch.items) WITH ORDINALITY x(value,ordinality)
   JOIN cinatoken_platform_delivery.jobs_v402 j ON j.event_id=(x.value->>'eventId')::uuid
   WHERE j.lease_nonce=p_lease_nonce AND j.status IN('publishing','published')
    AND j.lease_until>clock_timestamp() AND j.attempt_count=(x.value->>'attemptCount')::integer;
  RETURN jsonb_build_object('status','claimed','leaseNonce',p_lease_nonce,'items',live_items);
 END IF;
 FOR job IN SELECT * FROM cinatoken_platform_delivery.jobs_v402
  WHERE status IN('pending','publishing','published') AND next_attempt_at<=clock_timestamp()
  ORDER BY next_attempt_at,event_id LIMIT p_limit FOR UPDATE SKIP LOCKED LOOP
  at_time:=clock_timestamp();
  IF job.attempt_count>=7 THEN
   UPDATE cinatoken_platform_delivery.jobs_v402 SET status='dead_letter',lease_nonce=NULL,lease_until=NULL,
    dead_at=at_time,writer_xid=pg_current_xact_id() WHERE event_id=job.event_id;
  ELSE
   UPDATE cinatoken_platform_delivery.jobs_v402 SET status='publishing',attempt_count=attempt_count+1,
    lease_nonce=p_lease_nonce,lease_until=at_time+interval '30 seconds',next_attempt_at=at_time+interval '30 seconds',
    writer_xid=pg_current_xact_id() WHERE event_id=job.event_id;
   items:=items||jsonb_build_array(jsonb_build_object('eventId',job.event_id,'attemptCount',job.attempt_count+1,
    'leaseUntil',at_time+interval '30 seconds'));
  END IF;
 END LOOP;
 INSERT INTO cinatoken_platform_delivery.batches_v402 VALUES(p_lease_nonce,p_limit,items,clock_timestamp(),pg_current_xact_id());
 RETURN jsonb_build_object('status','claimed','leaseNonce',p_lease_nonce,'items',items);
END;
$claim$;

CREATE FUNCTION cinatoken_gateway.finish_complete_text_platform_publish_v402(p_event_id uuid,p_lease_nonce uuid,p_outcome text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO pg_catalog,pg_temp
SET lock_timeout TO '2s' SET statement_timeout TO '15s' AS $finish$
DECLARE job cinatoken_platform_delivery.jobs_v402%ROWTYPE; at_time timestamptz; result text; delay integer;
BEGIN
 PERFORM cinatoken_platform_delivery.require_actor_v402(ARRAY['cinatoken_gateway_complete_text_platform_event_publisher']);
 IF p_event_id IS NULL OR p_lease_nonce IS NULL OR p_outcome IS NULL OR p_outcome NOT IN('published','failed')
 THEN RAISE EXCEPTION 'v402 finish input' USING ERRCODE='22023'; END IF;
 SELECT * INTO job FROM cinatoken_platform_delivery.jobs_v402 WHERE event_id=p_event_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM cinatoken_platform_delivery.receipts_v402 WHERE event_id=p_event_id) THEN
  RETURN jsonb_build_object('status','already_consumed','eventId',p_event_id,'attemptCount',COALESCE(job.attempt_count,0));
 END IF;
 IF job.event_id IS NULL OR job.status NOT IN('publishing','published') OR job.lease_nonce IS DISTINCT FROM p_lease_nonce
  OR job.lease_until<=clock_timestamp() THEN
  RETURN jsonb_build_object('status','lease_lost','eventId',p_event_id,'attemptCount',COALESCE(job.attempt_count,0));
 END IF;
 IF job.status='published' AND p_outcome='published' THEN
  RETURN jsonb_build_object('status','published','eventId',p_event_id,'attemptCount',job.attempt_count);
 END IF;
 at_time:=clock_timestamp();
 IF p_outcome='published' THEN
  -- Broker acceptance does not prove consumption. An unconsumed publish becomes due again.
  UPDATE cinatoken_platform_delivery.jobs_v402 SET status='published',lease_until=at_time+interval '30 seconds',
   next_attempt_at=at_time+interval '30 seconds',writer_xid=pg_current_xact_id() WHERE event_id=p_event_id;
  result:='published';
 ELSIF job.attempt_count>=7 THEN
  UPDATE cinatoken_platform_delivery.jobs_v402 SET status='dead_letter',lease_nonce=NULL,lease_until=NULL,
   dead_at=at_time,writer_xid=pg_current_xact_id() WHERE event_id=p_event_id;
  result:='dead_letter';
 ELSE
  delay:=(ARRAY[5,15,45,135,405,1215])[job.attempt_count];
  UPDATE cinatoken_platform_delivery.jobs_v402 SET status='pending',lease_nonce=NULL,lease_until=NULL,
   next_attempt_at=at_time+make_interval(secs=>delay),writer_xid=pg_current_xact_id() WHERE event_id=p_event_id;
  result:='retry_scheduled';
 END IF;
 RETURN jsonb_build_object('status',result,'eventId',p_event_id,'attemptCount',job.attempt_count);
END;
$finish$;

CREATE FUNCTION cinatoken_gateway.consume_complete_text_platform_event_v402(p_event_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO pg_catalog,pg_temp
SET lock_timeout TO '2s' SET statement_timeout TO '15s' AS $consume$
DECLARE source jsonb; digest text; at_time timestamptz; result text;
 receipt cinatoken_platform_delivery.receipts_v402%ROWTYPE; job cinatoken_platform_delivery.jobs_v402%ROWTYPE;
BEGIN
 PERFORM cinatoken_platform_delivery.require_actor_v402(ARRAY['cinatoken_gateway_complete_text_platform_event_consumer']);
 IF p_event_id IS NULL THEN RAISE EXCEPTION 'v402 consume input' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(74692402,hashtext(p_event_id::text));
 SELECT * INTO job FROM cinatoken_platform_delivery.jobs_v402 WHERE event_id=p_event_id FOR UPDATE;
 source:=cinatoken_platform_delivery.read_source_v402(p_event_id);
 digest:=encode(sha256(convert_to(source::text,'UTF8')),'hex');
 SELECT * INTO receipt FROM cinatoken_platform_delivery.receipts_v402 WHERE event_id=p_event_id;
 IF receipt.event_id IS NOT NULL THEN
  IF receipt.projection_sha256<>digest OR NOT EXISTS(SELECT 1 FROM cinatoken_platform_delivery.projections_v402 p
   WHERE p.event_id=p_event_id AND p.projection=source AND p.projection_sha256=digest
    AND p.writer_xid=receipt.writer_xid AND p.consumed_at=receipt.consumed_at)
  THEN RAISE EXCEPTION 'v402 consumption replay differs' USING ERRCODE='23514'; END IF;
  at_time:=receipt.consumed_at; result:='already_consumed';
 ELSE
  at_time:=clock_timestamp(); result:='consumed';
  INSERT INTO cinatoken_platform_delivery.projections_v402 VALUES(p_event_id,(source->>'terminalId')::uuid,
   source->>'requestId',source->>'eventType',(source->>'eventVersion')::integer,source->>'payloadSha256',source,digest,at_time,pg_current_xact_id());
  INSERT INTO cinatoken_platform_delivery.receipts_v402 VALUES(p_event_id,digest,at_time,pg_current_xact_id());
  IF job.event_id IS NOT NULL THEN
   UPDATE cinatoken_platform_delivery.jobs_v402 SET status='delivered',next_attempt_at=at_time,lease_nonce=NULL,
    lease_until=NULL,delivered_at=at_time,dead_at=NULL,writer_xid=pg_current_xact_id() WHERE event_id=p_event_id;
  END IF;
 END IF;
 RETURN jsonb_build_object('status',result,'eventId',p_event_id,'terminalId',source->>'terminalId',
  'requestId',source->>'requestId','eventType',source->>'eventType','eventVersion',(source->>'eventVersion')::integer,
  'payloadSha256',source->>'payloadSha256','consumedAt',at_time);
END;
$consume$;

CREATE FUNCTION cinatoken_gateway.observe_complete_text_platform_event_v402(p_event_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO pg_catalog,pg_temp
SET lock_timeout TO '2s' SET statement_timeout TO '15s' AS $observe$
DECLARE receipt cinatoken_platform_delivery.receipts_v402%ROWTYPE; job cinatoken_platform_delivery.jobs_v402%ROWTYPE;
 source jsonb; result text; receipt_json jsonb; job_json jsonb;
BEGIN
 PERFORM cinatoken_platform_delivery.require_actor_v402(ARRAY['cinatoken_gateway_complete_text_platform_event_publisher',
  'cinatoken_gateway_complete_text_platform_event_consumer','cinatoken_gateway_migrator']);
 IF p_event_id IS NULL THEN RAISE EXCEPTION 'v402 observe input' USING ERRCODE='22023'; END IF;
 -- One event mutex keeps scan/consume snapshots coherent; it grants no publication authority.
 PERFORM pg_advisory_xact_lock(74692402,hashtext(p_event_id::text));
 IF NOT EXISTS(SELECT 1 FROM cinatoken_gateway.complete_text_platform_outbox_v388 WHERE event_id=p_event_id)
 THEN RETURN jsonb_build_object('status','missing','eventId',p_event_id,'receipt',NULL,'job',NULL); END IF;
 source:=cinatoken_platform_delivery.read_source_v402(p_event_id);
 SELECT * INTO receipt FROM cinatoken_platform_delivery.receipts_v402 WHERE event_id=p_event_id;
 SELECT * INTO job FROM cinatoken_platform_delivery.jobs_v402 WHERE event_id=p_event_id;
 IF receipt.event_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM cinatoken_platform_delivery.projections_v402 p WHERE p.event_id=p_event_id
   AND p.projection=source AND p.projection_sha256=receipt.projection_sha256
   AND p.consumed_at=receipt.consumed_at AND p.writer_xid=receipt.writer_xid
   AND p.projection_sha256=encode(sha256(convert_to(source::text,'UTF8')),'hex'))
   OR (job.event_id IS NOT NULL AND (job.status<>'delivered' OR job.delivered_at<>receipt.consumed_at))
  THEN RAISE EXCEPTION 'v402 observed receipt differs' USING ERRCODE='23514'; END IF;
  result:='consumed';
  receipt_json:=jsonb_build_object('eventId',p_event_id,'terminalId',source->>'terminalId','requestId',source->>'requestId',
   'eventType',source->>'eventType','eventVersion',(source->>'eventVersion')::integer,
   'payloadSha256',source->>'payloadSha256','consumedAt',receipt.consumed_at);
 ELSE
  IF EXISTS(SELECT 1 FROM cinatoken_platform_delivery.projections_v402 WHERE event_id=p_event_id) OR job.status='delivered'
  THEN RAISE EXCEPTION 'v402 observed companion missing' USING ERRCODE='23514'; END IF;
  result:='pending';
 END IF;
 IF job.event_id IS NOT NULL THEN job_json:=jsonb_build_object('status',job.status,'attemptCount',job.attempt_count,
  'nextAttemptAt',job.next_attempt_at,'leaseNonce',job.lease_nonce,'leaseUntil',job.lease_until); END IF;
 RETURN jsonb_build_object('status',result,'eventId',p_event_id,'receipt',receipt_json,'job',job_json);
END;
$observe$;

CREATE FUNCTION cinatoken_gateway.requeue_complete_text_platform_event_v402(p_event_id uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO pg_catalog,pg_temp
SET lock_timeout TO '2s' SET statement_timeout TO '15s' AS $requeue$
DECLARE job cinatoken_platform_delivery.jobs_v402%ROWTYPE; at_time timestamptz;
BEGIN
 PERFORM cinatoken_platform_delivery.require_actor_v402(ARRAY['cinatoken_gateway_migrator']);
 IF p_event_id IS NULL OR p_reason IS NULL OR octet_length(convert_to(p_reason,'UTF8')) NOT BETWEEN 1 AND 256
  OR p_reason<>btrim(p_reason) OR p_reason ~ '[[:cntrl:]]'
 THEN RAISE EXCEPTION 'v402 restore input' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(74692402,hashtext(p_event_id::text));
 SELECT * INTO job FROM cinatoken_platform_delivery.jobs_v402 WHERE event_id=p_event_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM cinatoken_platform_delivery.receipts_v402 WHERE event_id=p_event_id)
 THEN RETURN jsonb_build_object('status','already_consumed','eventId',p_event_id,'restoreCount',COALESCE(job.restore_count,0)); END IF;
 IF job.event_id IS NULL OR job.status<>'dead_letter' OR job.restore_count>=3
 THEN RAISE EXCEPTION 'v402 restore unavailable' USING ERRCODE='55000'; END IF;
 at_time:=clock_timestamp();
 UPDATE cinatoken_platform_delivery.jobs_v402 SET status='pending',attempt_count=0,restore_count=restore_count+1,
  next_attempt_at=at_time,lease_nonce=NULL,lease_until=NULL,dead_at=NULL,writer_xid=pg_current_xact_id() WHERE event_id=p_event_id;
 INSERT INTO cinatoken_platform_delivery.restores_v402 VALUES(p_event_id,job.restore_count+1,p_reason,at_time,pg_current_xact_id());
 RETURN jsonb_build_object('status','requeued','eventId',p_event_id,'restoreCount',job.restore_count+1);
END;
$requeue$;

REVOKE ALL ON ALL TABLES IN SCHEMA cinatoken_platform_delivery FROM PUBLIC,
 cinatoken_gateway_complete_text_platform_event_publisher,cinatoken_gateway_complete_text_platform_event_consumer;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA cinatoken_platform_delivery FROM PUBLIC,
 cinatoken_gateway_complete_text_platform_event_publisher,cinatoken_gateway_complete_text_platform_event_consumer;
REVOKE ALL ON FUNCTION cinatoken_gateway.scan_complete_text_platform_events_v402(integer),
 cinatoken_gateway.claim_complete_text_platform_events_v402(integer,uuid),
 cinatoken_gateway.finish_complete_text_platform_publish_v402(uuid,uuid,text),
 cinatoken_gateway.consume_complete_text_platform_event_v402(uuid),
 cinatoken_gateway.observe_complete_text_platform_event_v402(uuid),
 cinatoken_gateway.requeue_complete_text_platform_event_v402(uuid,text)
 FROM PUBLIC,cinatoken_gateway_runtime,cinatoken_gateway_complete_text_platform_event_publisher,cinatoken_gateway_complete_text_platform_event_consumer;
GRANT USAGE ON SCHEMA cinatoken_gateway TO cinatoken_gateway_complete_text_platform_event_publisher,
 cinatoken_gateway_complete_text_platform_event_consumer;
GRANT EXECUTE ON FUNCTION cinatoken_gateway.scan_complete_text_platform_events_v402(integer),
 cinatoken_gateway.claim_complete_text_platform_events_v402(integer,uuid),
 cinatoken_gateway.finish_complete_text_platform_publish_v402(uuid,uuid,text),
 cinatoken_gateway.observe_complete_text_platform_event_v402(uuid) TO cinatoken_gateway_complete_text_platform_event_publisher;
GRANT EXECUTE ON FUNCTION cinatoken_gateway.consume_complete_text_platform_event_v402(uuid),
 cinatoken_gateway.observe_complete_text_platform_event_v402(uuid) TO cinatoken_gateway_complete_text_platform_event_consumer;
`;

const publisherFunctions = ['scan_complete_text_platform_events_v402','claim_complete_text_platform_events_v402',
  'finish_complete_text_platform_publish_v402','observe_complete_text_platform_event_v402'];
const consumerFunctions = ['consume_complete_text_platform_event_v402','observe_complete_text_platform_event_v402'];
export function functionContractsV402() {
  return order([...ACTIONS_SQL_V402.matchAll(/CREATE FUNCTION ([\w.]+)\(([^)]*)\)\s*RETURNS (\w+) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO pg_catalog,pg_temp\s*(SET lock_timeout TO '2s' SET statement_timeout TO '15s'\s*)?AS \$(\w+)\$([\s\S]*?)\$\5\$;/gu)].map(m=>{
    const [,name,args,returns,timed,,body]=m;
    const types=args ? args.split(',').map(x=>x.trim().split(/\s+/u).slice(1).join(' ')).join(',') : '';
    const bare=name.split('.').at(-1);
    const acl=[grant(owner,'EXECUTE')];
    if(publisherFunctions.includes(bare)) acl.push(grant(PUBLISHER_ROLE_V402,'EXECUTE'));
    if(consumerFunctions.includes(bare)) acl.push(grant(CONSUMER_ROLE_V402,'EXECUTE'));
    return {signature:name+'('+types+')',owner,language:'plpgsql',kind:'f',returns_set:false,parallel:'u',strict:false,
      leakproof:false,security_definer:true,volatility:'v',return_type:returns,arguments:args.split(',').map(x=>x.trim()).join(', '),
      result_definition:returns,config:['search_path=pg_catalog, pg_temp',...(timed?['lock_timeout=2s','statement_timeout=15s']:[])],
      body_md5:md5(body),acl:order(acl,x=>x.grantee+'\0'+x.privilege)};
  }),x=>x.signature);
}

export function triggerContractsV402() {
  return order([...ACTIONS_SQL_V402.matchAll(/CREATE (CONSTRAINT )?TRIGGER (\w+) (BEFORE|AFTER) ([\w ]+) ON ([\w.]+)\s*(DEFERRABLE INITIALLY DEFERRED\s*)?FOR EACH (ROW|STATEMENT) EXECUTE FUNCTION ([\w.]+\(\));/gu)].map(m=>{
    const [,constraint,name,timing,events,table,deferred,level,func]=m;
    const eventNames=events.split(' OR ');
    let type=level==='ROW'?1:0;if(timing==='BEFORE')type+=2;
    for(const e of eventNames)type+=({INSERT:4,DELETE:8,UPDATE:16,TRUNCATE:32})[e];
    return {table,name,function:func,enabled:'O',type,qual:null,columns:'',arguments:'',argument_count:0,
      deferrable:!!deferred,initially_deferred:!!deferred,old_table:null,new_table:null,constraint:!!constraint,constraint_table:null,
      definition:`CREATE ${constraint?'CONSTRAINT ':''}TRIGGER ${name} ${timing} ${events} ON ${table}${deferred?' DEFERRABLE INITIALLY DEFERRED':''} FOR EACH ${level} EXECUTE FUNCTION ${func}`};
  }),x=>x.table+'\0'+x.name);
}

const tableColumns = {
  jobs_v402:[['event_id','uuid',true],['status','text',true],['attempt_count','integer',true],['restore_count','integer',true],
    ['next_attempt_at','timestamp with time zone',true],['lease_nonce','uuid',false],['lease_until','timestamp with time zone',false],
    ['delivered_at','timestamp with time zone',false],['dead_at','timestamp with time zone',false],['writer_xid','xid8',true]],
  batches_v402:[['lease_nonce','uuid',true],['requested_limit','integer',true],['items','jsonb',true],['created_at','timestamp with time zone',true],['writer_xid','xid8',true]],
  projections_v402:[['event_id','uuid',true],['terminal_id','uuid',true],['request_id','text',true],['event_type','text',true],
    ['event_version','integer',true],['payload_sha256','text',true],['projection','jsonb',true],['projection_sha256','text',true],
    ['consumed_at','timestamp with time zone',true],['writer_xid','xid8',true]],
  receipts_v402:[['event_id','uuid',true],['projection_sha256','text',true],['consumed_at','timestamp with time zone',true],['writer_xid','xid8',true]],
  restores_v402:[['event_id','uuid',true],['restore_count','integer',true],['reason','text',true],['restored_at','timestamp with time zone',true],['writer_xid','xid8',true]],
};
const tableAcl = ['DELETE','INSERT','MAINTAIN','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE'].map(x=>grant(owner,x));
export const TABLE_COLUMN_CONTRACTS_V402 = Object.fromEntries(Object.entries(tableColumns).map(([name,columns])=>[
  'cinatoken_platform_delivery.'+name,columns.map(([name,type,not_null],i)=>({position:i+1,name,type,not_null,identity:'',generated:'',
    default:null,collation:type==='text'?'"default"':null,acl:[]}))]));

// Exact PostgreSQL 18.3 embedded DDL deparse; no source actions were invoked.
export const TABLE_CONSTRAINT_CONTRACTS_V402 = {
  "cinatoken_platform_delivery.batches_v402": [
    {
      "name": "batches_v402_created_at_not_null",
      "type": "n",
      "validated": true,
      "deferrable": false,
      "definition": "NOT NULL created_at",
      "initially_deferred": false
    },
    {
      "name": "batches_v402_items_check",
      "type": "c",
      "validated": true,
      "deferrable": false,
      "definition": "CHECK (((jsonb_typeof(items) = 'array'::text) AND (jsonb_array_length(items) <= 20)))",
      "initially_deferred": false
    },
    {
      "name": "batches_v402_items_not_null",
      "type": "n",
      "validated": true,
      "deferrable": false,
      "definition": "NOT NULL items",
      "initially_deferred": false
    },
    {
      "name": "batches_v402_lease_nonce_not_null",
      "type": "n",
      "validated": true,
      "deferrable": false,
      "definition": "NOT NULL lease_nonce",
      "initially_deferred": false
    },
    {
      "name": "batches_v402_pkey",
      "type": "p",
      "validated": true,
      "deferrable": false,
      "definition": "PRIMARY KEY (lease_nonce)",
      "initially_deferred": false
    },
    {
      "name": "batches_v402_requested_limit_check",
      "type": "c",
      "validated": true,
      "deferrable": false,
      "definition": "CHECK (((requested_limit >= 1) AND (requested_limit <= 20)))",
      "initially_deferred": false
    },
    {
      "name": "batches_v402_requested_limit_not_null",
      "type": "n",
      "validated": true,
      "deferrable": false,
      "definition": "NOT NULL requested_limit",
      "initially_deferred": false
    },
    {
      "name": "batches_v402_writer_xid_not_null",
      "type": "n",
      "validated": true,
      "deferrable": false,
      "definition": "NOT NULL writer_xid",
      "initially_deferred": false
    }
  ],
  "cinatoken_platform_delivery.jobs_v402": [
    {
      "name": "jobs_v402_attempt_count_check",
      "type": "c",
      "validated": true,
      "deferrable": false,
      "definition": "CHECK (((attempt_count >= 0) AND (attempt_count <= 7)))",
      "initially_deferred": false
    },
    {
      "name": "jobs_v402_attempt_count_not_null",
      "type": "n",
      "validated": true,
      "deferrable": false,
      "definition": "NOT NULL attempt_count",
      "initially_deferred": false
    },
    {
      "name": "jobs_v402_companion",
      "type": "t",
      "validated": true,
      "deferrable": true,
      "definition": "TRIGGER DEFERRABLE INITIALLY DEFERRED",
      "initially_deferred": true
    },
    {
      "name": "jobs_v402_event_id_fkey",
      "type": "f",
      "validated": true,
      "deferrable": false,
      "definition": "FOREIGN KEY (event_id) REFERENCES cinatoken_gateway.complete_text_platform_outbox_v388(event_id)",
      "initially_deferred": false
    },
    {
      "name": "jobs_v402_event_id_not_null",
      "type": "n",
      "validated": true,
      "deferrable": false,
      "definition": "NOT NULL event_id",
      "initially_deferred": false
    },
    {
      "name": "jobs_v402_next_attempt_at_not_null",
      "type": "n",
      "validated": true,
      "deferrable": false,
      "definition": "NOT NULL next_attempt_at",
      "initially_deferred": false
    },
    {
      "name": "jobs_v402_pkey",
      "type": "p",
      "validated": true,
      "deferrable": false,
      "definition": "PRIMARY KEY (event_id)",
      "initially_deferred": false
    },
    {
      "name": "jobs_v402_restore_count_check",
      "type": "c",
      "validated": true,
      "deferrable": false,
      "definition": "CHECK (((restore_count >= 0) AND (restore_count <= 3)))",
      "initially_deferred": false
    },
    {
      "name": "jobs_v402_restore_count_not_null",
      "type": "n",
      "validated": true,
      "deferrable": false,
      "definition": "NOT NULL restore_count",
      "initially_deferred": false
    },
    {
      "name": "jobs_v402_state",
      "type": "c",
      "validated": true,
      "deferrable": false,
      "definition": "CHECK ((((status = 'pending'::text) AND (lease_nonce IS NULL) AND (lease_until IS NULL) AND (delivered_at IS NULL) AND (dead_at IS NULL)) OR ((status = ANY (ARRAY['publishing'::text, 'published'::text])) AND (attempt_count >= 1) AND (lease_nonce IS NOT NULL) AND (lease_until IS NOT NULL) AND (next_attempt_at = lease_until) AND (delivered_at IS NULL) AND (dead_at IS NULL)) OR ((status = 'delivered'::text) AND (lease_nonce IS NULL) AND (lease_until IS NULL) AND (delivered_at IS NOT NULL) AND (dead_at IS NULL)) OR ((status = 'dead_letter'::text) AND (lease_nonce IS NULL) AND (lease_until IS NULL) AND (delivered_at IS NULL) AND (dead_at IS NOT NULL))))",
      "initially_deferred": false
    },
    {
      "name": "jobs_v402_status_check",
      "type": "c",
      "validated": true,
      "deferrable": false,
      "definition": "CHECK ((status = ANY (ARRAY['pending'::text, 'publishing'::text, 'published'::text, 'delivered'::text, 'dead_letter'::text])))",
      "initially_deferred": false
    },
    {
      "name": "jobs_v402_status_not_null",
      "type": "n",
      "validated": true,
      "deferrable": false,
      "definition": "NOT NULL status",
      "initially_deferred": false
    },
    {
      "name": "jobs_v402_writer_xid_not_null",
      "type": "n",
      "validated": true,
      "deferrable": false,
      "definition": "NOT NULL writer_xid",
      "initially_deferred": false
    }
  ],
  "cinatoken_platform_delivery.projections_v402": [
    {
      "name": "projections_v402_companion",
      "type": "t",
      "validated": true,
      "deferrable": true,
      "definition": "TRIGGER DEFERRABLE INITIALLY DEFERRED",
      "initially_deferred": true
    },
    {
      "name": "projections_v402_consumed_at_not_null",
      "type": "n",
      "validated": true,
      "deferrable": false,
      "definition": "NOT NULL consumed_at",
      "initially_deferred": false
    },
    {
      "name": "projections_v402_event_id_fkey",
      "type": "f",
      "validated": true,
      "deferrable": false,
      "definition": "FOREIGN KEY (event_id) REFERENCES cinatoken_gateway.complete_text_platform_outbox_v388(event_id)",
      "initially_deferred": false
    },
    {
      "name": "projections_v402_event_id_not_null",
      "type": "n",
      "validated": true,
      "deferrable": false,
      "definition": "NOT NULL event_id",
      "initially_deferred": false
    },
    {
      "name": "projections_v402_event_type_check",
      "type": "c",
      "validated": true,
      "deferrable": false,
      "definition": "CHECK ((event_type = 'platform_text_no_fetch_closed'::text))",
      "initially_deferred": false
    },
    {
      "name": "projections_v402_event_type_not_null",
      "type": "n",
      "validated": true,
      "deferrable": false,
      "definition": "NOT NULL event_type",
      "initially_deferred": false
    },
    {
      "name": "projections_v402_event_version_check",
      "type": "c",
      "validated": true,
      "deferrable": false,
      "definition": "CHECK ((event_version = 1))",
      "initially_deferred": false
    },
    {
      "name": "projections_v402_event_version_not_null",
      "type": "n",
      "validated": true,
      "deferrable": false,
      "definition": "NOT NULL event_version",
      "initially_deferred": false
    },
    {
      "name": "projections_v402_payload_sha256_check",
      "type": "c",
      "validated": true,
      "deferrable": false,
      "definition": "CHECK ((payload_sha256 ~ '^[0-9a-f]{64}$'::text))",
      "initially_deferred": false
    },
    {
      "name": "projections_v402_payload_sha256_not_null",
      "type": "n",
      "validated": true,
      "deferrable": false,
      "definition": "NOT NULL payload_sha256",
      "initially_deferred": false
    },
    {
      "name": "projections_v402_pkey",
      "type": "p",
      "validated": true,
      "deferrable": false,
      "definition": "PRIMARY KEY (event_id)",
      "initially_deferred": false
    },
    {
      "name": "projections_v402_projection_not_null",
      "type": "n",
      "validated": true,
      "deferrable": false,
      "definition": "NOT NULL projection",
      "initially_deferred": false
    },
    {
      "name": "projections_v402_projection_sha256_check",
      "type": "c",
      "validated": true,
      "deferrable": false,
      "definition": "CHECK ((projection_sha256 ~ '^[0-9a-f]{64}$'::text))",
      "initially_deferred": false
    },
    {
      "name": "projections_v402_projection_sha256_not_null",
      "type": "n",
      "validated": true,
      "deferrable": false,
      "definition": "NOT NULL projection_sha256",
      "initially_deferred": false
    },
    {
      "name": "projections_v402_request_id_key",
      "type": "u",
      "validated": true,
      "deferrable": false,
      "definition": "UNIQUE (request_id)",
      "initially_deferred": false
    },
    {
      "name": "projections_v402_request_id_not_null",
      "type": "n",
      "validated": true,
      "deferrable": false,
      "definition": "NOT NULL request_id",
      "initially_deferred": false
    },
    {
      "name": "projections_v402_terminal_id_key",
      "type": "u",
      "validated": true,
      "deferrable": false,
      "definition": "UNIQUE (terminal_id)",
      "initially_deferred": false
    },
    {
      "name": "projections_v402_terminal_id_not_null",
      "type": "n",
      "validated": true,
      "deferrable": false,
      "definition": "NOT NULL terminal_id",
      "initially_deferred": false
    },
    {
      "name": "projections_v402_writer_xid_not_null",
      "type": "n",
      "validated": true,
      "deferrable": false,
      "definition": "NOT NULL writer_xid",
      "initially_deferred": false
    }
  ],
  "cinatoken_platform_delivery.receipts_v402": [
    {
      "name": "receipts_v402_companion",
      "type": "t",
      "validated": true,
      "deferrable": true,
      "definition": "TRIGGER DEFERRABLE INITIALLY DEFERRED",
      "initially_deferred": true
    },
    {
      "name": "receipts_v402_consumed_at_not_null",
      "type": "n",
      "validated": true,
      "deferrable": false,
      "definition": "NOT NULL consumed_at",
      "initially_deferred": false
    },
    {
      "name": "receipts_v402_event_id_fkey",
      "type": "f",
      "validated": true,
      "deferrable": false,
      "definition": "FOREIGN KEY (event_id) REFERENCES cinatoken_platform_delivery.projections_v402(event_id)",
      "initially_deferred": false
    },
    {
      "name": "receipts_v402_event_id_not_null",
      "type": "n",
      "validated": true,
      "deferrable": false,
      "definition": "NOT NULL event_id",
      "initially_deferred": false
    },
    {
      "name": "receipts_v402_pkey",
      "type": "p",
      "validated": true,
      "deferrable": false,
      "definition": "PRIMARY KEY (event_id)",
      "initially_deferred": false
    },
    {
      "name": "receipts_v402_projection_sha256_check",
      "type": "c",
      "validated": true,
      "deferrable": false,
      "definition": "CHECK ((projection_sha256 ~ '^[0-9a-f]{64}$'::text))",
      "initially_deferred": false
    },
    {
      "name": "receipts_v402_projection_sha256_not_null",
      "type": "n",
      "validated": true,
      "deferrable": false,
      "definition": "NOT NULL projection_sha256",
      "initially_deferred": false
    },
    {
      "name": "receipts_v402_writer_xid_not_null",
      "type": "n",
      "validated": true,
      "deferrable": false,
      "definition": "NOT NULL writer_xid",
      "initially_deferred": false
    }
  ],
  "cinatoken_platform_delivery.restores_v402": [
    {
      "name": "restores_v402_event_id_fkey",
      "type": "f",
      "validated": true,
      "deferrable": false,
      "definition": "FOREIGN KEY (event_id) REFERENCES cinatoken_platform_delivery.jobs_v402(event_id)",
      "initially_deferred": false
    },
    {
      "name": "restores_v402_event_id_not_null",
      "type": "n",
      "validated": true,
      "deferrable": false,
      "definition": "NOT NULL event_id",
      "initially_deferred": false
    },
    {
      "name": "restores_v402_pkey",
      "type": "p",
      "validated": true,
      "deferrable": false,
      "definition": "PRIMARY KEY (event_id, restore_count)",
      "initially_deferred": false
    },
    {
      "name": "restores_v402_reason_check",
      "type": "c",
      "validated": true,
      "deferrable": false,
      "definition": "CHECK ((((octet_length(convert_to(reason, 'UTF8'::name)) >= 1) AND (octet_length(convert_to(reason, 'UTF8'::name)) <= 256)) AND (reason = btrim(reason)) AND (reason !~ '[[:cntrl:]]'::text)))",
      "initially_deferred": false
    },
    {
      "name": "restores_v402_reason_not_null",
      "type": "n",
      "validated": true,
      "deferrable": false,
      "definition": "NOT NULL reason",
      "initially_deferred": false
    },
    {
      "name": "restores_v402_restore_count_check",
      "type": "c",
      "validated": true,
      "deferrable": false,
      "definition": "CHECK (((restore_count >= 1) AND (restore_count <= 3)))",
      "initially_deferred": false
    },
    {
      "name": "restores_v402_restore_count_not_null",
      "type": "n",
      "validated": true,
      "deferrable": false,
      "definition": "NOT NULL restore_count",
      "initially_deferred": false
    },
    {
      "name": "restores_v402_restored_at_not_null",
      "type": "n",
      "validated": true,
      "deferrable": false,
      "definition": "NOT NULL restored_at",
      "initially_deferred": false
    },
    {
      "name": "restores_v402_writer_xid_not_null",
      "type": "n",
      "validated": true,
      "deferrable": false,
      "definition": "NOT NULL writer_xid",
      "initially_deferred": false
    }
  ]
};
export const INDEX_CONTRACTS_V402 = [
  {
    "indexes": [
      {
        "live": true,
        "name": "batches_v402_pkey",
        "ready": true,
        "valid": true,
        "unique": true,
        "primary": true,
        "definition": "CREATE UNIQUE INDEX batches_v402_pkey ON cinatoken_platform_delivery.batches_v402 USING btree (lease_nonce)"
      }
    ],
    "table_name": "cinatoken_platform_delivery.batches_v402"
  },
  {
    "indexes": [
      {
        "live": true,
        "name": "jobs_v402_due",
        "ready": true,
        "valid": true,
        "unique": false,
        "primary": false,
        "definition": "CREATE INDEX jobs_v402_due ON cinatoken_platform_delivery.jobs_v402 USING btree (next_attempt_at, event_id) WHERE (status = ANY (ARRAY['pending'::text, 'publishing'::text, 'published'::text]))"
      },
      {
        "live": true,
        "name": "jobs_v402_pkey",
        "ready": true,
        "valid": true,
        "unique": true,
        "primary": true,
        "definition": "CREATE UNIQUE INDEX jobs_v402_pkey ON cinatoken_platform_delivery.jobs_v402 USING btree (event_id)"
      }
    ],
    "table_name": "cinatoken_platform_delivery.jobs_v402"
  },
  {
    "indexes": [
      {
        "live": true,
        "name": "projections_v402_pkey",
        "ready": true,
        "valid": true,
        "unique": true,
        "primary": true,
        "definition": "CREATE UNIQUE INDEX projections_v402_pkey ON cinatoken_platform_delivery.projections_v402 USING btree (event_id)"
      },
      {
        "live": true,
        "name": "projections_v402_request_id_key",
        "ready": true,
        "valid": true,
        "unique": true,
        "primary": false,
        "definition": "CREATE UNIQUE INDEX projections_v402_request_id_key ON cinatoken_platform_delivery.projections_v402 USING btree (request_id)"
      },
      {
        "live": true,
        "name": "projections_v402_terminal_id_key",
        "ready": true,
        "valid": true,
        "unique": true,
        "primary": false,
        "definition": "CREATE UNIQUE INDEX projections_v402_terminal_id_key ON cinatoken_platform_delivery.projections_v402 USING btree (terminal_id)"
      }
    ],
    "table_name": "cinatoken_platform_delivery.projections_v402"
  },
  {
    "indexes": [
      {
        "live": true,
        "name": "receipts_v402_pkey",
        "ready": true,
        "valid": true,
        "unique": true,
        "primary": true,
        "definition": "CREATE UNIQUE INDEX receipts_v402_pkey ON cinatoken_platform_delivery.receipts_v402 USING btree (event_id)"
      }
    ],
    "table_name": "cinatoken_platform_delivery.receipts_v402"
  },
  {
    "indexes": [
      {
        "live": true,
        "name": "restores_v402_pkey",
        "ready": true,
        "valid": true,
        "unique": true,
        "primary": true,
        "definition": "CREATE UNIQUE INDEX restores_v402_pkey ON cinatoken_platform_delivery.restores_v402 USING btree (event_id, restore_count)"
      }
    ],
    "table_name": "cinatoken_platform_delivery.restores_v402"
  }
];

function assertBaseline(baseline) {
  if(catalogDigestV400(baseline)!==BASELINE_CANONICAL_SHA256_V402 || baseline.functions.length!==142 ||
    baseline.relations.length!==93 || baseline.triggers.length!==135 || baseline.principals.length!==26)
    throw new Error('v402 selected baseline catalog differs');
}
function inheritedCatalog(actual) {
  const out=structuredClone(actual);const signatures=new Set(functionContractsV402().map(x=>x.signature));
  delete out.delivery_indexes;
  out.functions=out.functions.filter(x=>!signatures.has(x.signature));
  out.relations=out.relations.filter(x=>!Object.hasOwn(TABLE_COLUMN_CONTRACTS_V402,x.name));
  const triggers=new Set(triggerContractsV402().map(x=>x.table+'\0'+x.name));
  out.triggers=out.triggers.filter(x=>!triggers.has(x.table+'\0'+x.name));
  out.principals=out.principals.filter(x=>!roles.includes(x.name));
  out.schemas=out.schemas.filter(x=>x.name!=='cinatoken_platform_delivery').map(x=>x.name!=='cinatoken_gateway'?x:
    {...x,acl:x.acl.filter(a=>!(roles.includes(a.grantee)&&a.privilege==='USAGE'&&a.grantor===owner&&!a.grantable))});
  return out;
}
export function assertFinalCatalogV402(actual, baseline) {
  assertBaseline(baseline);
  if(catalogDigestV400(inheritedCatalog(actual))!==catalogDigestV400(baseline))throw new Error('v402 inherited catalog differs');
  const newFunctions=actual.functions.filter(x=>functionContractsV402().some(f=>f.signature===x.signature));
  if(catalogDigestV400(newFunctions)!==catalogDigestV400(functionContractsV402()))throw new Error('v402 new function catalog differs');
  const newTriggers=actual.triggers.filter(x=>x.table.startsWith('cinatoken_platform_delivery.'));
  if(catalogDigestV400(newTriggers)!==catalogDigestV400(triggerContractsV402()))throw new Error('v402 new trigger catalog differs');
  if(catalogDigestV400(actual.delivery_indexes)!==catalogDigestV400(INDEX_CONTRACTS_V402))throw new Error('v402 new index catalog differs');
  for(const role of roles){if(catalogDigestV400(actual.principals.find(x=>x.name===role))!==catalogDigestV400(freshRole(role)))throw new Error('v402 new principal differs');}
  for(const [name,columns]of Object.entries(TABLE_COLUMN_CONTRACTS_V402)){
    const r=actual.relations.find(x=>x.name===name);
    if(!r||r.owner!==owner||r.kind!=='r'||r.persistence!=='p'||r.rls||r.force_rls||r.rules.length||
      catalogDigestV400(r.acl)!==catalogDigestV400(tableAcl)||catalogDigestV400(r.columns)!==catalogDigestV400(columns)||
      catalogDigestV400(r.constraints)!==catalogDigestV400(TABLE_CONSTRAINT_CONTRACTS_V402[name]))throw new Error('v402 new relation differs: '+name);
  }
  const schema=actual.schemas.find(x=>x.name==='cinatoken_platform_delivery');
  if(catalogDigestV400(schema)!==catalogDigestV400({name:'cinatoken_platform_delivery',owner,acl:[grant(owner,'CREATE'),grant(owner,'USAGE')]}))throw new Error('v402 private schema differs');
  return {functions:actual.functions.length,relations:actual.relations.length,triggers:actual.triggers.length,
    principals:actual.principals.length,digest:catalogDigestV400(actual)};
}

function authorityGate(phase) {
  const allowed=phase==='preflight'?'false':functionContractsV402().flatMap(f=>f.acl.filter(a=>roles.includes(a.grantee))
    .map(a=>`(r.rolname='${a.grantee}' AND p.oid='${f.signature}'::regprocedure)`)).join(' OR ');
  return ` IF EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname IN('${roles.join("','")}') AND
  (has_database_privilege(r.oid,current_database(),'CREATE') OR EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND has_schema_privilege(r.oid,n.oid,'CREATE'))))
 OR EXISTS(SELECT 1 FROM pg_roles r CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE r.rolname IN('${roles.join("','")}') AND n.nspname NOT IN('pg_catalog','information_schema') AND
  CASE WHEN c.relkind IN('r','p','v','m','f') THEN has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') OR has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE')
   WHEN c.relkind='S' THEN has_sequence_privilege(r.oid,c.oid,'SELECT,USAGE,UPDATE') ELSE false END)
 OR EXISTS(SELECT 1 FROM pg_roles r CROSS JOIN pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE r.rolname IN('${roles.join("','")}') AND n.nspname NOT IN('pg_catalog','information_schema')
   AND has_function_privilege(r.oid,p.oid,'EXECUTE') AND NOT(${allowed}))
 THEN RAISE EXCEPTION 'v402 ${phase} new LOGIN authority differs' USING ERRCODE='P0001'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles r CROSS JOIN pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE r.rolname LIKE 'cinatoken_%' AND r.rolname<>'${owner}' AND n.nspname NOT LIKE 'cinatoken_%'
   AND n.nspname NOT IN('pg_catalog','information_schema') AND has_function_privilege(r.oid,p.oid,'EXECUTE'))
 OR EXISTS(SELECT 1 FROM pg_roles r CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE r.rolname LIKE 'cinatoken_%' AND r.rolname<>'${owner}' AND n.nspname NOT LIKE 'cinatoken_%'
   AND n.nspname NOT IN('pg_catalog','information_schema') AND CASE WHEN c.relkind IN('r','p','v','m','f') THEN
    has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') OR has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE')
    WHEN c.relkind='S' THEN has_sequence_privilege(r.oid,c.oid,'SELECT,USAGE,UPDATE') ELSE false END)
 THEN RAISE EXCEPTION 'v402 ${phase} external authority differs' USING ERRCODE='P0001'; END IF;\n`;
}
function gate(baseline,phase) {
  const functions=functionContractsV402();const triggers=triggerContractsV402();
  const signatures=functions.map(x=>x.signature);
  const strip=phase==='postflight'?`
 SELECT COALESCE(jsonb_agg(value ORDER BY value->>'signature'),'[]'::jsonb) INTO differences FROM jsonb_array_elements(actual->'functions') WHERE value->>'signature'=ANY(ARRAY[${signatures.map(x=>"'"+x+"'").join(',')}]);
 IF differences IS DISTINCT FROM $functions402$${JSON.stringify(functions)}$functions402$::jsonb THEN RAISE EXCEPTION 'v402 new function inventory differs' USING ERRCODE='P0001'; END IF;
 SELECT COALESCE(jsonb_agg(value ORDER BY value->>'table',value->>'name'),'[]'::jsonb) INTO differences FROM jsonb_array_elements(actual->'triggers') WHERE value->>'table' LIKE 'cinatoken_platform_delivery.%';
 IF differences IS DISTINCT FROM $triggers402$${JSON.stringify(triggers)}$triggers402$::jsonb THEN RAISE EXCEPTION 'v402 new trigger inventory differs' USING ERRCODE='P0001'; END IF;
 IF actual->'delivery_indexes' IS DISTINCT FROM $indexes402$${JSON.stringify(INDEX_CONTRACTS_V402)}$indexes402$::jsonb
 THEN RAISE EXCEPTION 'v402 new index inventory differs' USING ERRCODE='P0001'; END IF;
 IF actual->'schemas' @> jsonb_build_array(jsonb_build_object('name','cinatoken_platform_delivery','owner','${owner}','acl',$schema402$${JSON.stringify([grant(owner,'CREATE'),grant(owner,'USAGE')])}$schema402$::jsonb)) IS NOT TRUE
 THEN RAISE EXCEPTION 'v402 private schema differs' USING ERRCODE='P0001'; END IF;
 FOR expected_relation IN SELECT key,value FROM jsonb_each($columns402$${JSON.stringify(TABLE_COLUMN_CONTRACTS_V402)}$columns402$::jsonb) LOOP
  SELECT value INTO actual_relation FROM jsonb_array_elements(actual->'relations') WHERE value->>'name'=expected_relation.key;
  IF actual_relation IS NULL OR actual_relation->>'owner'<>'${owner}' OR actual_relation->>'kind'<>'r' OR actual_relation->>'persistence'<>'p'
   OR actual_relation->'rls'<>'false'::jsonb OR actual_relation->'force_rls'<>'false'::jsonb OR actual_relation->'rules'<>'[]'::jsonb
   OR actual_relation->'columns' IS DISTINCT FROM expected_relation.value
   OR actual_relation->'constraints' IS DISTINCT FROM ($constraints402$${JSON.stringify(TABLE_CONSTRAINT_CONTRACTS_V402)}$constraints402$::jsonb)->expected_relation.key
   OR actual_relation->'acl' IS DISTINCT FROM $tableacl402$${JSON.stringify(tableAcl)}$tableacl402$::jsonb
  THEN RAISE EXCEPTION 'v402 relation differs: %',expected_relation.key USING ERRCODE='P0001'; END IF;
 END LOOP;
 actual:=jsonb_set(actual,'{functions}',(SELECT COALESCE(jsonb_agg(value ORDER BY value->>'signature'),'[]'::jsonb) FROM jsonb_array_elements(actual->'functions') WHERE NOT(value->>'signature'=ANY(ARRAY[${signatures.map(x=>"'"+x+"'").join(',')}]))));
 actual:=jsonb_set(actual,'{relations}',(SELECT COALESCE(jsonb_agg(value ORDER BY value->>'name'),'[]'::jsonb) FROM jsonb_array_elements(actual->'relations') WHERE NOT(value->>'name'=ANY(ARRAY[${Object.keys(TABLE_COLUMN_CONTRACTS_V402).map(x=>"'"+x+"'").join(',')}]))));
 actual:=jsonb_set(actual,'{triggers}',(SELECT COALESCE(jsonb_agg(value ORDER BY value->>'table',value->>'name'),'[]'::jsonb) FROM jsonb_array_elements(actual->'triggers') WHERE value->>'table' NOT LIKE 'cinatoken_platform_delivery.%'));
 actual:=jsonb_set(actual,'{schemas}',(SELECT jsonb_agg(CASE WHEN value->>'name'='cinatoken_gateway' THEN jsonb_set(value,'{acl}',
  (SELECT jsonb_agg(a ORDER BY a->>'grantee',a->>'privilege') FROM jsonb_array_elements(value->'acl') a WHERE NOT(a->>'grantee'=ANY(ARRAY['${roles.join("','")}']) AND a->>'privilege'='USAGE' AND a->>'grantor'='${owner}' AND a->'grantable'='false'::jsonb))) ELSE value END ORDER BY value->>'name') FROM jsonb_array_elements(actual->'schemas') WHERE value->>'name'<>'cinatoken_platform_delivery'));
` : '';
  return `DO $${phase}402$
DECLARE expected jsonb:=$baseline402$${JSON.stringify(baseline)}$baseline402$::jsonb; actual jsonb; differences jsonb; category text;
 expected_relation record; actual_relation jsonb;
BEGIN
 IF CURRENT_USER<>'${owner}' OR SESSION_USER<>CURRENT_USER OR current_setting('role')<>'none'
  OR current_setting('transaction_isolation')<>'read committed' OR current_setting('session_replication_role')<>'origin'
  OR current_setting('cinatoken.complete_text_platform_event_delivery_v402_activation',true) IS DISTINCT FROM 'reviewed_v402'
  OR (SELECT count(*) FROM cinatoken_gateway.schema_migrations)<>73
  OR (SELECT md5(string_agg(version,E'\\n' ORDER BY version COLLATE "C")) FROM cinatoken_gateway.schema_migrations) IS DISTINCT FROM 'ca1ea96a1b4bcd0675642f30dcf48042'
 THEN RAISE EXCEPTION 'v402 ${phase} activation or PG73 differs' USING ERRCODE='P0001'; END IF;
 IF EXISTS(SELECT 1 FROM pg_db_role_setting s LEFT JOIN pg_roles r ON r.oid=s.setrole
  WHERE r.rolname LIKE 'cinatoken_%' OR (s.setrole=0 AND s.setdatabase IN(0,(SELECT oid FROM pg_database WHERE datname=current_database()))))
  OR EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname LIKE 'cinatoken_%' AND r.rolname<>'${owner}' AND has_parameter_privilege(r.oid,'session_replication_role','SET'))
  OR EXISTS(SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname LIKE 'cinatoken_%' OR c.relowner=(SELECT oid FROM pg_roles WHERE rolname='${owner}'))
 THEN RAISE EXCEPTION 'v402 ${phase} role settings/replication/policy differs' USING ERRCODE='P0001'; END IF;
 ${CATALOG_QUERY_V402.replace(') AS catalog',') INTO actual')};
 SELECT jsonb_agg(value ORDER BY value->>'name') INTO differences FROM jsonb_array_elements(actual->'principals') WHERE value->>'name'=ANY(ARRAY['${roles.join("','")}']);
 IF differences IS DISTINCT FROM $roles402$${JSON.stringify(order(roles.map(freshRole),x=>x.name))}$roles402$::jsonb THEN RAISE EXCEPTION 'v402 fresh roles differ' USING ERRCODE='P0001'; END IF;
 ${strip}
 actual:=jsonb_set(actual,'{principals}',(SELECT jsonb_agg(value ORDER BY value->>'name') FROM jsonb_array_elements(actual->'principals') WHERE NOT(value->>'name'=ANY(ARRAY['${roles.join("','")}']))));
 FOR category IN SELECT jsonb_object_keys(expected) LOOP
  IF actual->category IS DISTINCT FROM expected->category THEN RAISE EXCEPTION 'v402 ${phase} inherited catalog differs: %',category USING ERRCODE='P0001'; END IF;
 END LOOP;
 ${authorityGate(phase)}
END;
$${phase}402$;
`;
}
export function renderInstallerV402(baseline) {
  assertBaseline(baseline);
  if(functionContractsV402().length!==11||triggerContractsV402().length!==13)throw new Error('v402 action inventory differs');
  const locks=baseline.relations.filter(x=>['r','p'].includes(x.kind)).map(x=>x.name).join(',\n ');
  return `-- REVIEW ONLY. Default-off reliable delivery for immutable v388 no-fetch platform events.\n`+
    `-- No sent financial resolution, supplier bill, seller payout or formal migration. PG73 unchanged.\n`+
    `-- Baseline raw SHA256 ${BASELINE_RAW_SHA256_V402}; actions SHA256 ${sha(ACTIONS_SQL_V402)}.\n`+
    `SET LOCAL search_path TO pg_catalog,pg_temp;\nSET LOCAL lock_timeout='2s';\nSET LOCAL statement_timeout='15s';\n`+
    `SELECT pg_catalog.pg_advisory_xact_lock(74692402);\nLOCK TABLE ${locks} IN SHARE ROW EXCLUSIVE MODE NOWAIT;\n`+
    gate(baseline,'preflight')+ACTIONS_SQL_V402+gate(baseline,'postflight');
}
export async function loadBaselineV402() {
  const raw=await readFile(new URL('scripts/db/cutover/fixtures/complete-text-platform-event-delivery-baseline-v402.json',root),'utf8');
  if(sha(raw)!==BASELINE_RAW_SHA256_V402)throw new Error('v402 baseline source hash differs');
  const baseline=JSON.parse(raw);assertBaseline(baseline);return baseline;
}
export async function buildInstallerV402() {
  const sql=renderInstallerV402(await loadBaselineV402());
  const output=new URL('packages/core/migrations-proposals/postgres/complete-text-platform-event-delivery-v402.sql',root);
  await writeFile(output,sql,'utf8');return {path:fileURLToPath(output),sha256:sha(sql),bytes:Buffer.byteLength(sql)};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])console.log(JSON.stringify(await buildInstallerV402()));
