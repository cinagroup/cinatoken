import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {BYOK_D1_ORIGIN} from '../../packages/proxy/scripts/staging/byok-d1-one-shot.ts';
import {BYOK_D1_INSTALL_ACTION,parseByokD1InstallGrant,parseByokD1InstallReceipt} from '../../packages/proxy/scripts/staging/byok-d1-install-contract.ts';
const hash=v=>createHash('sha256').update(v).digest('hex');
const cancel=b=>{try{void b?.cancel().catch(()=>{});}catch{}};

/** One fixed native installation command, journaled BEFORE send. No CLI, URL,
 * schema body, replay, grant minting, Access mutation or provisioning. The full
 * deployment/isolation/plan/budget guard is supplied by the trusted operator;
 * journal ACKs alone do not constitute a valid preflight. */
export function createByokD1InstallDispatch(options){
  let journal,grant,token,accessClientId,accessClientSecret,assertReady,timeoutMs,fetchImpl;
  try{
    assert.ok(options&&Object.keys(options).every(k=>['journal','grant','token','accessClientId','accessClientSecret','assertReady','timeoutMs','fetchImpl'].includes(k)));
    ({journal,token,accessClientId,accessClientSecret,assertReady,timeoutMs=30000,fetchImpl=fetch}=options);
    grant=parseByokD1InstallGrant(JSON.stringify(options.grant));
    assert.match(token,/^[a-f0-9]{64}$/);assert.equal(hash(token),grant.tokenHash);assert.equal(grant.runId,journal.identity.runId);
    for(const v of [accessClientId,accessClientSecret])assert.match(v,/^[\x21-\x7e]{1,512}$/);
    assert.equal(typeof assertReady,'function');assert.equal(typeof fetchImpl,'function');assert.equal(typeof journal.attempt,'function');
    assert.ok(Number.isInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=30000);
  }catch{throw Error('byok_install_dispatch_options');}
  async function command(signal){
    const ac=new AbortController(),deadline=performance.now()+timeoutMs;let timer,onAbort,reader,response,finished=false;
    const interrupted=new Promise((_,reject)=>{
      onAbort=()=>{finished=true;ac.abort();cancel(reader);reject(Error('interrupted'));};
      signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();timer=setTimeout(onAbort,timeoutMs);
    });
    const live=()=>{ac.signal.throwIfAborted();assert.ok(performance.now()<deadline);};
    const work=Promise.resolve().then(async()=>{
      live();response=await fetchImpl(BYOK_D1_ORIGIN+'/__staging/byok-d1/'+BYOK_D1_INSTALL_ACTION,{
        method:'POST',redirect:'error',cache:'no-store',signal:ac.signal,
        headers:{Authorization:'Bearer '+token,'CF-Access-Client-Id':accessClientId,'CF-Access-Client-Secret':accessClientSecret,
          'X-CinaToken-BYOK-Command':'install-fence-once-v1','Content-Length':'0'},
      });
      if(finished){cancel(response.body);throw Error('interrupted');}live();
      assert.equal(response.status,200);assert.equal(response.redirected,false);
      assert.match(response.headers.get('Content-Type')??'',/^application\/json(?:;\s*charset=utf-8)?$/i);assert.equal(response.headers.get('Cache-Control'),'no-store');
      const length=response.headers.get('Content-Length');if(length!==null)assert.ok(/^(0|[1-9][0-9]*)$/.test(length)&&Number(length)<=2048);
      assert.ok(response.body);reader=response.body.getReader();let bytes=0,reads=0;const chunks=[];
      for(;;){live();assert.ok(++reads<=128);const n=await reader.read();live();if(n.done)break;
        bytes+=n.value.byteLength;assert.ok(bytes<=2048);chunks.push(Buffer.from(n.value));}
      if(length!==null)assert.equal(Number(length),bytes);
      const receipt=parseByokD1InstallReceipt(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,bytes))),grant);live();return receipt;
    });
    try{return await Promise.race([work,interrupted]);}
    finally{finished=true;clearTimeout(timer);signal?.removeEventListener('abort',onAbort);ac.abort();
      if(reader){try{void reader.cancel().catch(()=>{}).finally(()=>{try{reader.releaseLock();}catch{}});}catch{}}else cancel(response?.body);}
  }
  return Object.freeze({async run({signal}={}){
    try{return await journal.attempt('install-fence',()=>{
      const s=journal.snapshot();
      for(const step of ['preflight','closure-before','open-access','open-gateway'])assert.equal(s.attempts[step],'ACK');
      for(const step of ['baseline','arm','open-fence','stop','seal-fence'])assert.equal(s.attempts[step],undefined);
      const now=Math.floor(Date.now()/1000);assert.ok(now>=grant.issuedAt&&now<grant.expiresAt);assert.equal(assertReady(),true);
      return command(signal);
    },r=>({publicHttp:1,evidenceSha256:hash(JSON.stringify(r)),rowsRead:r.counters.acknowledgedRowsRead,rowsWritten:r.counters.acknowledgedRowsWritten}));
    }catch{throw Error('byok_install_dispatch_unconfirmed');}
  }});
}
