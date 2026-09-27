import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {SSE_STAGING_SCOPE as gateway} from './staging-sse-reconciliation.mjs';
import {closeSseRecoveryAccess} from './staging-sse-recovery-access-v2.mjs';
import {withSseIngressConfirmation} from './staging-sse-ingress-confirmation.mjs';
import {imageSseFixture} from './staging-image-sse-fixture.mjs';
import {assertSseHostExpiryEvidence} from './staging-sse-host-expiry-evidence-v3.mjs';
import {assertSseCapacityPeerAcceptance} from './staging-sse-capacity-peer-acceptance.mjs';
import {hostExpirySseCleanupNotBefore, reconcileHostExpirySseStagingRun} from './staging-sse-host-expiry-reconciliation-v3.mjs';

const copy = value => structuredClone(value);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ingress = `/workers/scripts/${gateway.worker}/subdomain`;
const tails = `/workers/scripts/${gateway.worker}/tails`;
const tables = ['request_dispatch_intents','request_usage_settlements','request_usage_recovery_jobs',
  'request_usage_commit_receipts','api_key_request_logs','user_budget_reservations'];
const sha = value => createHash('sha256').update(value).digest('hex');

/** One-shot outer resource owner for the peer coordinator. No I/O on import.
 * Supply the SAME session, public-call reserve and bounded staging transports
 * used by the core. No inference callback exists here. Never reconstruct this
 * owner to retry an uncertain mutation. Read-only reinspection is separate.
 *
 * awaitPrimary must resolve only when the original pending body read has ended
 * (including rejection). readNative returns raw cancel/snapshot rows, not a
 * boolean. tail is {creation:'not-attempted'} or {creation:'attempted',id?}; a
 * lost create ACK without an exact ID cannot authorize tail deletion.
 */
export function createSseCapacityPeerFinalizer({session,coordinator,api,batch,persist,reserve,tail,stopTail}) {
  const {clock} = session;
  let finishing;
  const errors = [], writes = new Set();
  const report = {result:'RUNNING',experimentResult:'NOT_PROVEN',cleanupPassed:false,
    fixtureRemoved:false,accessClosed:false,tailAbsent:false,keyRevoked:false,
    recoveryAttempts:0,c02GatePassed:false,isolateEvictionProven:false,errors};
  const fail = stage => { if (!errors.includes(stage)) errors.push(stage); };
  async function bound(work,ms=20000) {
    const deadline = clock.after(clock.sample(),ms), controller = new AbortController();
    let timer;
    try {
      const value = await Promise.race([Promise.resolve().then(()=>work(controller.signal)),
        new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('finalizer_timeout'));},clock.remaining(deadline));})]);
      assert.ok(clock.remaining(deadline)>0);return value;
    } finally { clearTimeout(timer);controller.abort(); }
  }
  const save = event => {
    assert.ok(!errors.includes('journal'),'A failed containment journal forbids subsequent data operations');
    return bound(signal=>persist(copy(event),{signal}),5000);
  };
  // Containment must continue even with a failed journal. This does NOT permit
  // recovery or data deletion: those paths require successful strict saves.
  const containmentSave = async event => { try { await save(event); } catch { fail('journal'); } };
  const transport = async(path,method='GET',body,options={}) => {
    if (method!=='GET') {
      const key=method+' '+path;assert.ok(!writes.has(key),'Never replay an uncertain management write');writes.add(key);
    }
    return bound(signal=>api(path,method,body,{signal:options.signal?AbortSignal.any([signal,options.signal]):signal}));
  };
  const closedApi = withSseIngressConfirmation({api:transport,clock,persist:containmentSave});
  const sql = statements => bound(signal=>batch(statements,{signal}));
  async function attempt(stage,work) { try { return await work(); } catch { fail(stage);return undefined; } }
  async function closeGateway() {
    let value;try { value=await closedApi(ingress); } catch { /* A fixed close is still safe after an uncertain read. */ }
    if(value?.enabled!==false||value?.previews_enabled!==false) {
      await closedApi(ingress,'POST',{enabled:false,previews_enabled:false});value=await closedApi(ingress);
    }
    assert.equal(value.enabled,false);assert.equal(value.previews_enabled,false);
    await containmentSave({step:'peer-finalizer-gateway-closed'});return true;
  }
  async function finish({ownership,awaitPrimary,readNative,runRecovery,onWait}={}) {
    // Capture resource identity before any await; malformed metadata must never
    // prevent fixed ingress containment. Never retain access secret material.
    let owned,ownedTail;
    try {
      owned={runId:ownership.runId,tokenName:ownership.tokenName,tokenId:ownership.tokenId};
      assert.equal(owned.runId,session.plan.runId);assert.equal(owned.tokenName,session.plan.tokenName);
      if(owned.tokenId!==undefined)assert.match(owned.tokenId,uuid);
    }
    catch { owned={};fail('ownership'); }
    try { ownedTail=copy(tail); } catch { fail('tail-ownership'); }
    await attempt('primary-stop',()=>coordinator.close());
    const gatewayClosing = attempt('gateway-close',closeGateway);
    let state = await attempt('coordinator-report',()=>coordinator.report());
    // close() captures the first actual abort, not body completion. A timeout
    // here leaves timing incomplete, preventing native proof and data deletion.
    if(state?.journal.requests.some(r=>r.timing?.cancel&&!r.timing?.finished)) {
      await attempt('primary-finish',async()=>{
        assert.equal(typeof awaitPrimary,'function');await bound(awaitPrimary,10000);
        coordinator.finishAbortedPrimary();
      });
      state=await attempt('coordinator-report',()=>coordinator.report());
    }
    const gatewayClosed = await gatewayClosing;
    const journal=state?{...state.journal,...owned}:owned;
    let platform, proofRows;
    // A failed experiment remains failed even if its resources can be removed.
    if(state?.state==='OBSERVED') await attempt('joint-proof',async()=>{
      const decision=assertSseCapacityPeerAcceptance(state);report.experimentResult=decision.result;
    });
    else report.experimentResult='FAILED_OR_INCOMPLETE';
    if(gatewayClosed) await attempt('native-proof',async()=>{
      assert.equal(journal.runId,session.plan.runId);
      assert.equal(journal.requests.length,1);assert.equal(journal.requests[0].mode,'after-hold');
      // Callback may await the original live tail collector. No synthetic proof
      // or new collector is accepted, including after observation failure.
      const raw=state.native??await bound(signal=>readNative({signal}),65000);
      assert.ok(Buffer.byteLength(JSON.stringify(raw))<=16384);
      proofRows={snapshotRow:copy(raw.observation.snapshotRow),cancelRow:copy(raw.cancelRow)};
      platform=session.platform();assert.equal(platform.events.length,1);
      assertSseHostExpiryEvidence({journal,...proofRows,tail:platform.events[0],version:platform.version,receipts:platform.receipts});
      const db=await transport('/d1/database/'+gateway.database);assert.equal(db.uuid,gateway.database);assert.equal(db.name,'cinatoken-staging');
      const current=await sql([{sql:'SELECT key,value,description FROM system_config WHERE key IN (?,?) ORDER BY key LIMIT 3',
        params:['c02_sse_snapshot:'+journal.requests[0].probeId,'c02_sse_cancel:'+journal.requests[0].probeId]}]);
      assert.equal(current.length,1);assert.deepEqual(current[0].map(row=>({...row})),[proofRows.cancelRow,proofRows.snapshotRow]);
      await save({step:'peer-finalizer-native-proof',journal,proofRows,platform});
      // A failed peer sample before recovery may leave one owned pending job.
      // Once ANY core RPC was attempted, including a lost ACK, never issue a
      // replacement. Final reconciliation reads durable facts after quiescence.
      if(state.state!=='OBSERVED'&&session.lastRpcFinished===undefined&&!(state.recovery?.calls.length)&&typeof runRecovery==='function') {
        assert.equal(errors.length,0,'Containment/journal failure forbids recovery');
        const groups=await sql(tables.map(table=>({sql:`SELECT * FROM ${table} ORDER BY ${table==='api_key_request_logs'?'id':'request_id'} LIMIT 3`,params:[]})));
        assert.ok(Buffer.byteLength(JSON.stringify(groups))<=1048576);
        assert.equal(groups.length,6);
        if(groups[2].length===1&&groups[2][0].state==='committed') return; // Read-only; no dedup RPC in failure cleanup.
        assert.deepEqual(groups.map(rows=>rows.length),[1,1,1,0,0,1]);
        const [intent,snapshot,job,,,reservation]=groups.map(rows=>rows[0]);
        for(const row of [intent,snapshot,job,reservation]) {
          assert.equal(row.request_id,journal.requests[0].id);assert.equal(row.user_id,journal.runId+'-user');assert.equal(row.api_key_id,journal.runId+'-key');
          if(row!==reservation)assert.equal(row.workspace_id,journal.runId+'-workspace');
        }
        assert.equal(job.state,'pending');assert.equal(job.lease_token,null);
        assert.equal(intent.attempt_index,1);assert.equal(snapshot.attempt_index,1);
        assert.equal(intent.operation,'images.generations');assert.equal(snapshot.operation,intent.operation);
        assert.equal(snapshot.context_sha256,intent.context_sha256);assert.equal(snapshot.dispatch_claim_id,intent.dispatch_claim_id);
        assert.ok(Buffer.byteLength(snapshot.payload_json)<=262144);assert.equal(sha(snapshot.payload_json),snapshot.payload_sha256);
        assert.equal(snapshot.payload_sha256,JSON.parse(proofRows.snapshotRow.value).payloadSha256);assert.equal(job.payload_sha256,snapshot.payload_sha256);
        assert.equal(reservation.state,'dispatched');assert.equal(reservation.reserved_micros,100000);assert.equal(reservation.settled_micros,0);
        // A global recovery controller must have no outstanding controls/leases.
        const controls=await sql([{sql:'SELECT key FROM system_config WHERE key IN (?,?) LIMIT 3',params:['c02_recovery_claim_delay_v1','c02_recovery_fencing_control_v1']}]);
        assert.deepEqual(controls,[[]]);
        reserve();report.recoveryAttempts++;
        await save({step:'peer-finalizer-recovery',result:'PENDING',observed:groups,started:clock.sample()});
        await attempt('recovery-ack',async()=>{
          const value=await session.rpc(signal=>bound(inner=>runRecovery({signal:AbortSignal.any([signal,inner]),expected:1}),30000));
          assert.ok(Buffer.byteLength(JSON.stringify(value))<=8192);assert.equal(value.status,200);
          const body=value.body;assert.equal(body.status,'finished');assert.equal(body.retry_safe,false);assert.match(body.runId,uuid);
          for(const key of ['scanned','claimed','committed'])assert.equal(body.result[key],1);
          for(const key of ['blocked','deferred','lostOwnership','uncertain','skipped'])assert.equal(body.result[key],0);
          assert.equal(body.result.capacityLimited,false);assert.equal(body.result.admissionStopped,false);
          await save({step:'peer-finalizer-recovery',result:'ACK',body,finished:session.lastRpcFinished});
        });
      }
    });
    // Always attempt BOTH fixed closures; no recovery operation occurs below.
    const access=await attempt('access-close',()=>closeSseRecoveryAccess({api:closedApi,journal:owned,persist:containmentSave}));
    report.accessClosed=!!access;
    const socketStopped=await attempt('tail-socket',async()=>{assert.equal(typeof stopTail,'function');await bound(stopTail,5000);return true;});
    report.tailAbsent=!!await attempt('tail-close',async()=>{
      assert.ok(socketStopped);assert.ok(ownedTail&&['not-attempted','attempted'].includes(ownedTail.creation));
      if(ownedTail.creation==='attempted') {
        assert.match(ownedTail.id,/^[a-f0-9-]{32,36}$/);
        const before=await transport(tails);assert.ok(Array.isArray(before));
        const matching=before.filter(t=>t.id===ownedTail.id);assert.ok(matching.length<=1);
        if(matching.length)await transport(tails+'/'+ownedTail.id,'DELETE');
        const after=await transport(tails);assert.ok(Array.isArray(after)&&after.every(t=>t.id!==ownedTail.id));
      }
      await containmentSave({step:'peer-finalizer-tail-absent',creation:ownedTail.creation});return true;
    });
    // Revoke the exact fixture key independently of financial/native validity.
    await attempt('key-revoke',async()=>{
      assert.equal(owned.runId,session.plan.runId);
      const db=await transport('/d1/database/'+gateway.database);assert.equal(db.uuid,gateway.database);assert.equal(db.name,'cinatoken-staging');
      const fixture=await imageSseFixture(owned.runId,session.plan.keyHash,session.plan.expiresAt);
      await sql([fixture.revoke]);
      const rows=await sql([{sql:'SELECT id,user_id,workspace_id,key_hash,status FROM api_keys WHERE id=?',params:[fixture.ids.key]}]);
      assert.equal(rows.length,1);assert.ok(rows[0].length<=1);
      if(rows[0].length)assert.deepEqual({...rows[0][0]},{id:fixture.ids.key,user_id:fixture.ids.user,workspace_id:fixture.ids.workspace,key_hash:session.plan.keyHash,status:'revoked'});
      report.keyRevoked=true;
    });
    if(report.accessClosed&&report.tailAbsent&&report.keyRevoked&&platform&&proofRows&&!errors.includes('native-proof')&&!errors.includes('journal')) {
      await attempt('data-reconcile',async()=>{
        const notBefore=hostExpirySseCleanupNotBefore(journal,clock,session.lastRpcFinished);
        await save({step:'peer-finalizer-quiescence',notBefore,lastRpcFinished:session.lastRpcFinished});
        await clock.waitUntil(notBefore,{onWait});
        // Original full-field/atomic oracle re-reads all financial/native rows;
        // ACK loss is neither zero-cost evidence nor permission to replay.
        const reconciliationBatch=async statements=>{
          const rows=await sql(statements);
          if(statements.length===11&&!rows.every(group=>group.length===0)) {
            assert.deepEqual(rows[6].map(row=>({...row})),[proofRows.snapshotRow]);assert.deepEqual(rows[8].map(row=>({...row})),[proofRows.cancelRow]);
          }
          return rows;
        };
        const cleaned=await reconcileHostExpirySseStagingRun({api:closedApi,batch:reconciliationBatch,journal,clock,lastRpcFinished:session.lastRpcFinished,persist:save,platform});
        report.fixtureRemoved=cleaned.fixtureRemoved;report.cleanupPassed=cleaned.fixtureRemoved;
      });
    }
    report.result=report.cleanupPassed&&errors.length===0?'CLOSED':'ATTENTION_REQUIRED';
    await attempt('final-journal',()=>save({step:'peer-finalizer-complete',...report}));
    if(errors.length)report.result='ATTENTION_REQUIRED';
    return copy(report);
  }
  return Object.freeze({finish(options){return finishing??=finish(options);},report:()=>copy(report)});
}
