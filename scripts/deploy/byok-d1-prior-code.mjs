import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {parseByokWorkerContent} from './byok-worker-content.mjs';
import {SSE_STAGING_SCOPE as g} from './staging-sse-reconciliation.mjs';
import {SSE_RECOVERY_ACCESS_SCOPE as c} from './staging-sse-recovery-access-v2.mjs';
const sha=v=>createHash('sha256').update(v).digest('hex'),copy=v=>structuredClone(v);
const names=[g.worker,c.worker,'cinatoken-staging-usage-recovery'];
const hex=/^[a-f0-9]{64}$/,uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const cancel=b=>{try{void b?.cancel().catch(()=>{});}catch{}};

/** Read and archive complete code for the THREE existing staging replacement
 * targets. No cloud writes, SQL, arbitrary URLs, retries, execution or rollback.
 * Success is a version/settings-bound code observation, not full preflight,
 * exclusivity, quiescence or an authorization to restore old experiments.
 */
export function createByokD1PriorCode({workspace,expected,apiToken,fetchImpl=fetch,timeoutMs=60000,signal}){
  const baseline=copy(expected);assert.equal(typeof workspace,'string');assert.equal(typeof fetchImpl,'function');
  assert.match(apiToken,/^[\x21-\x7e]{1,512}$/);assert.ok(Number.isInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=60000);
  assert.ok(signal===undefined||signal instanceof AbortSignal);
  assert.deepEqual(baseline.map(w=>w.name).sort(),names.slice().sort());
  for(const w of baseline){assert.match(w.settingsSha256,hex);assert.match(w.versionId,uuid);if(w.entrySha256!==undefined)assert.match(w.entrySha256,hex);}
  const root=resolve(workspace),directory=resolve(root,'.wrangler/staging/byok-d1-prior-code-reservation');
  let promise,fd,sequence=0,previous='0'.repeat(64),closed=false;
  const report={result:'NOT_RUN',cloudWrites:0,automaticRetries:0,codeComplete:false,fullPreflightPassed:false,
    restoreAuthorized:false,operations:[],workers:[],journalRecords:0};
  function save(event){
    assert.ok(!closed&&sequence<64);const record={sequence:sequence+1,previous,...event},digest=sha(JSON.stringify(record));
    const bytes=Buffer.from(JSON.stringify({...record,sha256:digest})+'\n');assert.ok(bytes.length<=4096);
    for(let at=0;at<bytes.length;){const n=fs.writeSync(fd,bytes,at,bytes.length-at);assert.ok(n>0);at+=n;}fs.fsyncSync(fd);
    sequence++;previous=digest;report.journalRecords=sequence;
  }
  async function execute(){
    const ac=new AbortController(),begin=performance.now();let timer,onAbort;
    const interrupted=new Promise((_,reject)=>{onAbort=()=>{ac.abort();reject(Error('prior_code_interrupted'));};
      signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();timer=setTimeout(onAbort,timeoutMs);});interrupted.catch(()=>{});
    const live=()=>{assert.ok(!closed&&performance.now()-begin<timeoutMs);ac.signal.throwIfAborted();};
    async function request(worker,kind){
      live();assert.ok(report.operations.length<15);const path='/workers/scripts/'+worker+(kind==='content'?'':'/'+kind);
      const op={attempt:report.operations.length+1,path,method:'GET',kind,result:'PENDING',receivedBytes:0};report.operations.push(op);save(op);
      const start=performance.now(),limit=kind==='content'?60000:20000,max=kind==='content'?12582912:2097152;
      let response,reader,requestTimer,settled=false;
      const deadline=new Promise((_,reject)=>{requestTimer=setTimeout(()=>{ac.abort();reject(Error('read_timeout'));},limit);});
      const check=()=>{live();assert.ok(performance.now()-start<limit);};
      const work=Promise.resolve().then(async()=>{
        check();response=await fetchImpl('https://api.cloudflare.com/client/v4/accounts/'+g.account+path,
          {method:'GET',headers:{Authorization:'Bearer '+apiToken,Accept:kind==='content'?'*/*':'application/json'},redirect:'error',cache:'no-store',signal:ac.signal});
        if(ac.signal.aborted||settled){cancel(response.body);throw Error('read_late');}check();op.status=response.status;
        assert.equal(response.status,200);assert.equal(response.redirected,false);assert.ok(response.body);
        const type=response.headers.get('Content-Type')??'',encoding=response.headers.get('Content-Encoding'),length=response.headers.get('Content-Length');
        assert.ok(type.length<=256);assert.ok(encoding===null||['gzip','br','deflate','identity'].includes(encoding));
        if(length!==null)assert.ok(/^(0|[1-9][0-9]*)$/.test(length)&&Number(length)<=max);
        reader=response.body.getReader();const chunks=[];let reads=0;
        for(;;){check();assert.ok(++reads<=32768);const v=await reader.read();check();if(v.done)break;
          assert.ok(v.value instanceof Uint8Array);op.receivedBytes+=v.value.byteLength;assert.ok(op.receivedBytes<=max);chunks.push(Buffer.from(v.value));}
        if(length!==null&&(!encoding||encoding==='identity'))assert.equal(op.receivedBytes,Number(length));
        const data=Buffer.concat(chunks,op.receivedBytes);op.responseSha256=sha(data);check();
        if(kind==='content')return parseByokWorkerContent({data,type,entrypoint:response.headers.get('cf-entrypoint')??undefined});
        assert.match(type,/^application\/json(?:;\s*charset=utf-8)?$/i);const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));
        assert.equal(value.success,true);assert.ok(value.errors==null||Array.isArray(value.errors)&&value.errors.length===0);assert.ok(Object.hasOwn(value,'result'));
        return value.result;
      });
      try{const value=await Promise.race([work,deadline,interrupted]);check();op.result='ACK';return value;}
      catch{op.result='FAILED_OR_UNCERTAIN';ac.abort();throw Error('prior_code_read_failed');}
      finally{settled=true;clearTimeout(requestTimer);cancel(reader??response?.body);op.elapsedMs=Math.floor(performance.now()-start);save({...op});}
    }
    async function worker(w){
      const stable=async()=>{assert.equal(sha(JSON.stringify(await request(w.name,'settings'))),w.settingsSha256);
        assert.deepEqual((await request(w.name,'deployments')).deployments[0].versions,[{version_id:w.versionId,percentage:100}]);};
      await stable();const content=await request(w.name,'content');live();
      const entry=content.modules.find(m=>m.name===content.entrypoint);assert.ok(entry);if(w.entrySha256)assert.equal(entry.sha256,w.entrySha256);
      const modules=[];for(const [i,m] of content.modules.entries()){
        live();const filename=w.name+'-'+i+'.bin',path=resolve(directory,filename);let file;
        try{file=fs.openSync(path,'wx',0o600);for(let at=0;at<m.bytes.length;){const n=fs.writeSync(file,m.bytes,at,m.bytes.length-at);assert.ok(n>0);at+=n;}fs.fsyncSync(file);}
        finally{if(file!==undefined)fs.closeSync(file);}live();assert.equal(sha(fs.readFileSync(path)),m.sha256);
        modules.push({name:m.name,filename,bytes:m.bytes.length,sha256:m.sha256});
      }
      await stable();live();const result={name:w.name,versionId:w.versionId,settingsSha256:w.settingsSha256,entrypoint:content.entrypoint,modules};
      report.workers.push(result);save({event:'WORKER_VERIFIED',name:w.name,moduleCount:modules.length,manifestSha256:sha(JSON.stringify(result))});
    }
    try{
      live();assert.equal(fs.realpathSync(root),root);for(const part of [resolve(root,'.wrangler'),resolve(root,'.wrangler/staging')]){
        if(!fs.existsSync(part))fs.mkdirSync(part);assert.equal(fs.realpathSync(part),part);assert.ok(fs.lstatSync(part).isDirectory()&&!fs.lstatSync(part).isSymbolicLink());}
      fs.mkdirSync(directory);fd=fs.openSync(resolve(directory,'journal.jsonl'),'wx',0o600);report.result='RUNNING';
      save({event:'RESERVED',scope:names,expectedSha256:sha(JSON.stringify(baseline))});
      const outcomes=await Promise.allSettled(baseline.map(w=>worker(w).catch(e=>{ac.abort();throw e;})));live();
      assert.ok(outcomes.every(r=>r.status==='fulfilled'));assert.equal(report.workers.length,3);
      report.workers.sort((a,b)=>a.name.localeCompare(b.name));report.codeComplete=true;report.result='CODE_OBSERVED_AND_ARCHIVED';
    }catch{report.result='FAILED_RETAINED';report.codeComplete=false;}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);ac.abort();report.finishedAt=new Date().toISOString();report.elapsedMs=Math.floor(performance.now()-begin);
      if(fd!==undefined){try{save({event:'FINISHED',result:report.result,codeComplete:report.codeComplete});}catch{report.result='FAILED_RETAINED';report.codeComplete=false;}
        closed=true;fs.closeSync(fd);const text=JSON.stringify(report,null,2);assert.ok(!text.includes(apiToken));
        let resultFd;try{resultFd=fs.openSync(resolve(directory,'result.json'),'wx',0o600);const bytes=Buffer.from(text);
          for(let at=0;at<bytes.length;){const n=fs.writeSync(resultFd,bytes,at,bytes.length-at);assert.ok(n>0);at+=n;}fs.fsyncSync(resultFd);
        }catch{report.result='FAILED_RETAINED';report.codeComplete=false;throw Error('prior_code_result_not_durable');}
        finally{if(resultFd!==undefined)fs.closeSync(resultFd);}}}
    return copy(report);
  }
  return Object.freeze({run(){return promise??=execute();},report:()=>copy(report)});
}
