// Emits the review-only legacy-aware variant of the pinned V1 parent proposal.
// It does not infer a request digest or budget for formal 0069 history. Existing
// request IDs must already be permanently reserved by the separate replay
// reservation proposal, then the parent gate must be installed in the SAME
// transaction as this variant before any new writer receives EXECUTE.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const parentProposal = new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-parent-deadline-budget.sql', import.meta.url);
const expectedSourceSha256 = '2e8c20088f72271ecf89bc4f43583ec3b2247893a11b84cc6a220563a72de8de';
const oldPreflight = `  IF EXISTS (SELECT 1 FROM cinatoken_gateway.request_dispatch_intents) THEN
    RAISE EXCEPTION 'Existing dispatch intents need separately reviewed request backfill';
  END IF;`;
const oldComment = `-- Existing intent rows have no trustworthy original request budget, so this
-- proposal rejects them instead of inventing a backfill or deleting evidence.`;
const newComment = `-- Existing intent rows have no trustworthy original request digest or budget.
-- This variant leaves their evidence intact behind permanent replay reservations;
-- no old row is converted into a trusted V1 parent.`;
const oldAclComment = `-- CREATE applies any migrator/schema ALTER DEFAULT PRIVILEGES. A REVOKE from
-- PUBLIC alone would leave an explicit role grant, including one inherited by
-- a future producer. Audit the just-created objects before this transaction
-- can commit; aborting here rolls back the table and all three functions.`;
const newAclComment = `-- CREATE applies migrator/schema default ACLs. Ordinary runtime provisioning
-- gives new tables SELECT and new functions EXECUTE by default. Remove only
-- those known grants, then reject every remaining nonowner ACL below.`;
const oldAclRevoke = `REVOKE ALL ON FUNCTION cinatoken_gateway.classify_request_dispatch_intent_v1(
  text,integer,text,text,text,text,text,text,bigint) FROM PUBLIC;`;
const newAclRevoke = `${oldAclRevoke}
REVOKE ALL ON TABLE cinatoken_gateway.request_dispatch_requests
  FROM cinatoken_gateway_runtime;
REVOKE EXECUTE ON FUNCTION cinatoken_gateway.prepare_request_dispatch_intent_v1(
  text,integer,text,text,text,text,text,text,bigint,integer)
  FROM cinatoken_gateway_runtime;
REVOKE EXECUTE ON FUNCTION cinatoken_gateway.claim_request_dispatch_intent_v1(
  text,integer,text,text,text,text,text,text,bigint,text)
  FROM cinatoken_gateway_runtime;
REVOKE EXECUTE ON FUNCTION cinatoken_gateway.classify_request_dispatch_intent_v1(
  text,integer,text,text,text,text,text,text,bigint)
  FROM cinatoken_gateway_runtime;`;
const newPreflight = `  -- Formal 0069 lacks a trustworthy original request digest, total budget or
  -- request deadline. Keep those old attempts in place and reserve their IDs
  -- forever; only new parent rows can carry V1 trusted request identity.
  IF pg_catalog.to_regclass('cinatoken_gateway.request_dispatch_replay_tombstones') IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
      WHERE tgrelid = 'cinatoken_gateway.request_dispatch_intents'::pg_catalog.regclass
        AND tgname = 'request_dispatch_intents_replay_reserve'
        AND tgenabled = 'O' AND NOT tgisinternal AND tgtype = 7) THEN
    RAISE EXCEPTION 'Legacy request replay reservation installation is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM cinatoken_gateway.request_dispatch_intents i
      WHERE NOT EXISTS (SELECT 1 FROM cinatoken_gateway.request_dispatch_replay_tombstones r
        WHERE r.request_id = i.request_id)) THEN
    RAISE EXCEPTION 'Legacy request replay reservation backfill is incomplete';
  END IF;
  -- V1 parent claim/classify functions cannot operate an old row with no
  -- trustworthy parent. Finish every old attempt through the old supervised
  -- classifier before switching writers. A prior claim remains consumed even
  -- after outcome_unknown, and any immutable financial history stays put.
  IF EXISTS (SELECT 1 FROM cinatoken_gateway.request_dispatch_intents
      WHERE state IN ('prepared', 'dispatch_claimed')) THEN
    RAISE EXCEPTION 'Legacy active dispatch intents must drain before parent switch';
  END IF;
  -- The base proposal inspects relation ACLs. Old direct writers may instead
  -- have per-column INSERT/UPDATE grants, which would bypass parent admission.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a,
      LATERAL pg_catalog.aclexplode(a.attacl) acl
      WHERE a.attrelid = 'cinatoken_gateway.request_dispatch_intents'::pg_catalog.regclass
        AND a.attnum > 0 AND NOT a.attisdropped
        AND acl.grantee <> migrator_oid
        AND acl.privilege_type IN ('INSERT', 'UPDATE')) THEN
    RAISE EXCEPTION 'Direct dispatch intent column writer privilege remains';
  END IF;`;

export async function buildRequestLegacyParentActivation() {
  const source = await readFile(parentProposal);
  const sourceSha256 = createHash('sha256').update(source).digest('hex');
  if (sourceSha256 !== expectedSourceSha256) {
    throw new Error('Pinned V1 request parent proposal changed; review legacy variant again');
  }
  const normalized = source.toString('utf8').replaceAll('\r\n', '\n');
  if (normalized.split(oldPreflight).length !== 2) {
    throw new Error('Pinned V1 request parent preflight shape changed');
  }
  if (normalized.split(oldComment).length !== 2) {
    throw new Error('Pinned V1 request parent explanation changed');
  }
  if (normalized.split(oldAclComment).length !== 2
    || normalized.split(oldAclRevoke).length !== 2) {
    throw new Error('Pinned V1 request parent ACL review shape changed');
  }
  const sql = `-- REVIEW ONLY. Legacy-aware parent activation derived from the pinned V1 proposal.\n`
    + `-- Source SHA-256: ${sourceSha256}\n`
    + `-- This is not a hash/budget/deadline backfill. Old intents remain untouched.\n`
    + `-- Requires replay reservation installation and completed bounded backfill.\n`
    + `-- Apply this SQL and request-dispatch-replay-parent-gate.sql in ONE\n`
    + `-- explicit migrator transaction after its reviewed activation assertion.\n`
    + `-- Parent and replay gate functions receive no producer EXECUTE here.\n`
    + normalized.replace(oldComment, newComment).replace(oldPreflight, newPreflight)
      .replace(oldAclRevoke, newAclRevoke).replace(oldAclComment, newAclComment);
  return Object.freeze({ sql, sourceSha256 });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.length !== 2) throw new Error('Usage: node build-request-legacy-parent-activation.mjs');
  process.stdout.write((await buildRequestLegacyParentActivation()).sql);
}
