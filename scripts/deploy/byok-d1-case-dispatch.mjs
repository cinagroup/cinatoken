import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {BYOK_D1_CASES} from '../../packages/proxy/scripts/staging/byok-d1-acceptance.ts';
import {BYOK_D1_ORIGIN,parseByokD1Control} from '../../packages/proxy/scripts/staging/byok-d1-one-shot.ts';

const hash=v=>createHash('sha256').update(v).digest('hex');
const exact=(v,names)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===names.slice().sort().join(',');
const cancel=body=>{try{void body?.cancel().catch(()=>{});}catch{}};

/** Host-only ordered case calls plus an independent, once-only STOP. No API for
 * a caller-selected URL, case, SQL, retries, resume or resource provisioning.
 * The trusted operator must first freeze candidates, reserve costs, install the
 * fence and control, and verify Access and staging identity. A PASS HTTP receipt
 * still needs the operator's independent D1 readback. This is not that operator.
 * Requires the repository's TypeScript loader (or a frozen Node ESM bundle).
 */
export function createByokD1CaseDispatch({journal,control,token,accessClientId,accessClientSecret,
  timeoutMs=30000,fetchImpl=fetch}) {
  assert.equal(typeof journal?.attempt,'function');assert.equal(typeof journal?.snapshot,'function');assert.equal(typeof fetchImpl,'function');
  assert.ok(typeof token==='string'&&/^[a-f0-9]{64}$/.test(token),'Invalid case credential');
  for(const v of [accessClientId,accessClientSecret])
    assert.ok(typeof v==='string'&&v.length>0&&v.length<=512&&/^[\x21-\x7e]+$/.test(v),'Invalid Access credential');
  assert.ok(Number.isSafeInteger(timeoutMs)&&timeoutMs>=1&&timeoutMs<=30000,'Invalid command timeout');
  // Do not include caller data in parser/assertion error diagnostics.
  let initial;
  try {
    initial=parseByokD1Control(JSON.stringify(control));
    assert.equal(initial.state,'ready');assert.equal(initial.cursor,0);assert.equal(initial.receipts.length,0);
    assert.equal(initial.tokenHash,hash(token));assert.equal(journal.identity.runId,initial.runId);
  } catch { throw Error('Invalid initial case control'); }
  const receipts=[];
  let active=false,failed=false,stopped=false,stopStarted=false;

  async function command(action,signal,validate) {
    const ac=new AbortController(),deadline=performance.now()+timeoutMs;
    let timer,onAbort,reader,response,finished=false;
    const interrupted=new Promise((_,reject)=>{
      onAbort=()=>{finished=true;ac.abort();cancel(reader);reject(Error('case_command_interrupted'));};
      signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();
      timer=setTimeout(onAbort,timeoutMs);
    });
    const live=()=>{ac.signal.throwIfAborted();assert.ok(performance.now()<deadline,'case_command_deadline');};
    const work=Promise.resolve().then(async()=>{
      live();
      response=await fetchImpl(BYOK_D1_ORIGIN+'/__staging/byok-d1/'+action,{
        method:'POST',redirect:'error',cache:'no-store',signal:ac.signal,
        headers:{Authorization:'Bearer '+token,'CF-Access-Client-Id':accessClientId,'CF-Access-Client-Secret':accessClientSecret,
          'X-CinaToken-BYOK-Command':action==='stop'?'stop-once-v1':'case-once-v1','Content-Length':'0'},
      });
      if(finished){cancel(response.body);throw Error('case_command_interrupted');}live();
      assert.equal(response.status,200);assert.equal(response.redirected,false);
      assert.match(response.headers.get('Content-Type')??'',/^application\/json(?:;\s*charset=utf-8)?$/i);
      assert.equal(response.headers.get('Cache-Control'),'no-store');
      const declared=response.headers.get('Content-Length');
      if(declared!==null)assert.ok(/^(0|[1-9][0-9]*)$/.test(declared)&&Number(declared)<=8192);
      assert.ok(response.body);reader=response.body.getReader();let bytes=0,reads=0;const chunks=[];
      for(;;){live();assert.ok(++reads<=256,'case_command_read_limit');const next=await reader.read();live();if(next.done)break;
        bytes+=next.value.byteLength;assert.ok(bytes<=8192,'case_command_body_limit');chunks.push(Buffer.from(next.value));}
      if(declared!==null)assert.equal(bytes,Number(declared));
      const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,bytes)));
      const result=validate(value);live();return result;
    });
    try{return await Promise.race([work,interrupted]);}
    finally{
      finished=true;clearTimeout(timer);signal?.removeEventListener('abort',onAbort);ac.abort();
      if(reader){try{void reader.cancel().catch(()=>{}).finally(()=>{try{reader.releaseLock();}catch{}});}catch{}}
      else cancel(response?.body);
    }
  }
  return Object.freeze({
    async runNext({signal}={}) {
      const attempts=journal.snapshot().attempts;
      assert.ok(!active&&!failed&&!stopped&&!attempts.stop&&!attempts['seal-fence']&&receipts.length<BYOK_D1_CASES.length,
        'Case dispatch is stopped or busy');
      active=true;const index=receipts.length,caseId=BYOK_D1_CASES[index];
      try {
        const receipt=await journal.attempt('case-'+index,()=>command(caseId,signal,value=>{
          assert.ok(exact(value,['code','receipt']));assert.equal(value.code,'case_pass');
          // Reuse the exact durable receipt contract, including bounded nested
          // metadata, ordered IDs and the explicit absence of mid-batch proof.
          const projected=parseByokD1Control(JSON.stringify({...initial,state:index===9?'done':'ready',cursor:index+1,
            pendingCase:null,receipts:[...receipts,value.receipt]}));
          const result=projected.receipts[index];assert.equal(result.caseId,caseId);assert.equal(result.outcome,'PASS');
          return result;
        }),r=>({publicHttp:1,completedCases:index+1,evidenceSha256:hash(JSON.stringify(r))}));
        receipts.push(receipt);return structuredClone(receipt);
      } catch { failed=true;throw Error('byok_case_dispatch_unconfirmed'); }
      finally { active=false; }
    },
    async stop({signal}={}) {
      assert.equal(stopStarted,false,'STOP cannot be replayed');stopStarted=true;stopped=true;
      try {
        return await journal.attempt('stop',()=>command('stop',signal,value=>{
          assert.ok(exact(value,['code']));assert.equal(value.code,'admissions_stopped');
          return {code:'admissions_stopped'};
        }),r=>({publicHttp:1,evidenceSha256:hash(JSON.stringify(r))}));
      } catch { failed=true;throw Error('byok_case_stop_unconfirmed'); }
    },
    snapshot:()=>({runId:initial.runId,completedCases:receipts.length,caseInFlight:active,failed,stopped,stopStarted,mayReplay:false}),
  });
}
