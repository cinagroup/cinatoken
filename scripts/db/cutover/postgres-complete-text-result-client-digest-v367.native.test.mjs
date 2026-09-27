// Owned PostgreSQL 18.6 verification of the v367 client's JSONB bind and digest.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import {
  appendPostgresCompleteTextHolderFactV367,
  appendPostgresCompleteTextProviderBillFactV367,
} from '../../../packages/proxy/src/services/postgres-complete-text-result-facts-v367.ts';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';

const reportUrl=new URL('../../../docs/developers/architecture/implementation-evidence/C04-complete-text-result-client-digest-v367-report.json',import.meta.url);
const clientUrl=new URL('../../../packages/proxy/src/services/postgres-complete-text-result-facts-v367.ts',import.meta.url);
const sqlUrl=new URL('../../../packages/core/migrations-proposals/postgres/complete-text-result-facts-v366.sql',import.meta.url);
const holderRole='cinatoken_gateway_complete_text_send_holder';
const billRole='cinatoken_gateway_complete_text_provider_bill';
const holderConnection=`postgres://${holderRole}:synthetic@localhost:5432/synthetic?sslmode=disable`;
const billConnection=`postgres://${billRole}:synthetic@localhost:5432/synthetic?sslmode=disable`;
const grantId='77777777-7777-7777-7777-777777777777';
const runId='88888888-8888-8888-8888-888888888888';
const nonce='99999999-9999-9999-9999-999999999999';
const factId='66666666-6666-6666-6666-666666666666';
const hex='a'.repeat(64);
const sha=value=>createHash('sha256').update(value).digest('hex');

function captureFactory(expectedRole, capture) {
  return (connection,options)=>{
    assert.equal(connection,expectedRole===holderRole?holderConnection:billConnection);
    assert.deepEqual(options,{max:1});
    return {
      async begin(callback) {
        return callback({async unsafe(query,args) {
          if(query.includes('current_user')) return [{current_role:expectedRole,
            session_role:expectedRole,transaction_isolation:'read committed'}];
          assert.match(query,/append_complete_text_(holder_fact|provider_bill)_v366/u);
          assert.match(query,/::text::jsonb/u);
          capture.args=args;
          capture.query=query;
          return [{value:{status:'fact_recorded',factId,
            evidenceSha256:args.at(-1)}}];
        }});
      },
      end({timeout}) {assert.equal(timeout,1);return Promise.resolve();},
    };
  };
}

test('v367 canonical evidence and text-to-JSONB bind equal PostgreSQL 18.6',
  {timeout:120_000,skip:!process.env.GATEWAY_NATIVE_PG_BIN},async()=>{
    const cluster=await startNativePostgres();
    const report={status:'RUNNING',cleanup:'PENDING',binaryVersion:cluster.binaryVersion,
      sourceSha256:{client:sha(await readFile(clientUrl)),
        v366Sql:sha(await readFile(sqlUrl))},stages:[],limitations:[
        'This local fixture checks Postgres.js parameter encoding, JSONB object type, canonical text and SHA-256 equality. It does not install the v366 writer or authenticate a bill source.',
        'The v366 evidence grammar restricts references to ASCII letters, digits and ._:/-. Non-ASCII, quotes and backslashes are rejected before this digest boundary.',
        'The injected transaction tests client argument mapping only; the separate v366 SQL fixture covers real roles, grants, writes and append-only rows.',
        'No remote database, provider, Worker or production credential is used.'
      ]};
    let failure;
    try {
      assert.match(cluster.binaryVersion,/PostgreSQL\) 18\.6/u);
      const cases=[
        ['no-fetch',{kind:'no_fetch_attestation',observation:'fetch_not_called'}],
        ['fetch-invoked',{kind:'fetch_invoked',observation:'fetch_invoked',uploadSha256:hex}],
        ['transport-unknown',{kind:'transport_unknown',observation:'transport_unknown',phase:'body'}],
        ['zero-observation',{kind:'provider_zero_charge_observation',
          providerRequestRef:'req-1',reportedChargeMicros:0,signalSha256:hex}],
        ['provider-usage',{kind:'provider_usage',providerRequestRef:'req-1',
          inputTokens:999999999,outputTokens:0}],
        ['bill-zero',{providerRequestRef:'req-1',providerEventId:'evt-1',
          currency:'USD',amountMicros:'0',billDocumentSha256:hex}],
        ['bill-max',{providerRequestRef:'req-1',providerEventId:'evt-2',
          currency:'USD',amountMicros:'999999999999999999',billDocumentSha256:hex}],
      ];
      for(const [name,evidence] of cases) {
        const bill=name.startsWith('bill-');
        const capture={};
        const receipt=bill
          ?await appendPostgresCompleteTextProviderBillFactV367({
            billConnectionString:billConnection,grantId,evidenceNonce:nonce,
            evidence},captureFactory(billRole,capture))
          :await appendPostgresCompleteTextHolderFactV367({
            holderConnectionString:holderConnection,grantId,holderRunId:runId,
            expectedEpoch:1,evidenceNonce:nonce,evidence},
          captureFactory(holderRole,capture));
        const jsonText=capture.args.at(-2);
        const digest=capture.args.at(-1);
        assert.equal(receipt.evidenceSha256,digest);
        assert.equal(sha(jsonText),digest);
        const [native]=await cluster.admin.unsafe(`SELECT
          pg_catalog.jsonb_typeof($1::text::jsonb) AS evidence_type,
          $1::text::jsonb::text AS canonical_text,
          pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
            $1::text::jsonb::text,'UTF8')),'hex') AS digest,
          $1::text::jsonb->>'amountMicros' AS amount_micros`,[jsonText]);
        assert.equal(native.evidence_type,'object',name);
        assert.equal(native.canonical_text,jsonText,name);
        assert.equal(native.digest,digest,name);
        if(name==='bill-max') assert.equal(native.amount_micros,'999999999999999999');
        report.stages.push({name,result:'PASS'});
      }
      report.status='PASS';
    } catch(error) {failure=error;report.status='FAIL';report.error=String(error?.stack??error);}
    try {await cluster.cleanup();report.cleanup='PASS';}
    catch(error) {report.cleanup='FAIL';report.cleanupError=String(error?.stack??error);
      if(!failure)failure=error;}
    await writeFile(reportUrl,JSON.stringify(report,null,2)+'\n');
    if(failure)throw failure;
  });
