import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';

const account='7ea8e46d8210bad342fa7595f7935fea',db='6bf5d41e-fe0b-4afa-9f67-ff5cf82e23d1';
const targets=['cinatoken-proxy-staging','cinatoken-staging-recovery-control','cinatoken-staging-usage-recovery','cinatoken-staging-images-upstream'];
const a='/accounts/'+account,sha=v=>createHash('sha256').update(v).digest('hex');
const name=v=>{assert.ok(typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v));return v;};
const id=v=>{assert.match(v,/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/);return v;};
const list=(v,max=1000)=>{assert.ok(Array.isArray(v)&&v.length<=max);return v;};
const object=v=>{assert.ok(v!==null&&typeof v==='object'&&!Array.isArray(v));return v;};
const cancel=v=>{try{void v?.cancel().catch(()=>{});}catch{}};
const text=v=>{assert.ok(typeof v==='string'&&v.length>0&&v.length<=256&&!/[\x00-\x1f]/.test(v));return v;};
const optional=(v,validate=name)=>v==null?undefined:validate(v);
const unique=xs=>{assert.equal(new Set(xs).size,xs.length);return xs;};

/** Read-only discovery of current deployment versions (INCLUDING 0%) and every
 * listed version when Preview URLs are enabled. No cloud writes or admission.
 * A disabled preview flag is an observed routing condition, not deletion of old
 * versions. Each default service is checked before/after; legacy environments
 * stop this collector rather than being silently omitted. */
export function createByokD1VersionInventory({workspace,apiToken,fetchImpl=fetch,timeoutMs=600000,signal}){
  assert.equal(typeof workspace,'string');assert.match(apiToken,/^[\x21-\x7e]{1,512}$/);assert.equal(typeof fetchImpl,'function');
  assert.ok(Number.isInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=600000);assert.ok(signal===undefined||signal instanceof AbortSignal);
  const root=resolve(workspace),dir=resolve(root,'.wrangler/staging/byok-d1-version-inventory-reservation');
  let promise,fd,closed=false,sequence=0,previous='0'.repeat(64);
  const report={result:'NOT_RUN',account,targets,stagingDatabase:db,cloudWrites:0,automaticRetries:0,
    // Discovery can take minutes. This is never a maintenance freshness grant.
    discoveryBudget:{timeoutMs,requestLimit:1000,concurrency:4,requestTimeoutMs:20000,responseBytes:2097152},
    callableDefaultVersionBindingsObserved:false,allInvocationPathsInventoried:false,fullPreflightPassed:false,
    snapshotIsAtomic:false,visibilityScopeVerified:false,operations:[],workers:[],edges:[],
    uncovered:['TOKEN_RESOURCE_VISIBILITY','HISTORICAL_PAGES_DEPLOYMENT_BINDINGS','DISPATCH_NAMESPACES',
      'ZONE_ROUTES','NON_CATALOGUED_INVOCATION_SOURCES','CURRENT_INGRESS_CLOSURE','IN_FLIGHT_SQL_AND_EXTERNAL_D1_CLIENTS']};
  function persist(v){assert.ok(fd!==undefined&&!closed&&sequence<2002);const row={sequence:sequence+1,previous,...v},digest=sha(JSON.stringify(row));
    const bytes=Buffer.from(JSON.stringify({...row,sha256:digest})+'\n');assert.ok(bytes.length<=4096&&!bytes.toString().includes(apiToken));
    for(let at=0;at<bytes.length;){const n=fs.writeSync(fd,bytes,at,bytes.length-at);assert.ok(n>0);at+=n;}fs.fsyncSync(fd);sequence++;previous=digest;}
  function writeResult(){const value=JSON.stringify(report,null,2);assert.ok(!value.includes(apiToken));let out;
    try{out=fs.openSync(resolve(dir,'result.json'),'wx',0o600);const bytes=Buffer.from(value);
      for(let at=0;at<bytes.length;){const n=fs.writeSync(out,bytes,at,bytes.length-at);assert.ok(n>0);at+=n;}fs.fsyncSync(out);
    }finally{if(out!==undefined)fs.closeSync(out);}}
  async function execute(){
    const start=performance.now(),ac=new AbortController();let timer,onAbort;
    const interrupted=new Promise((_,reject)=>{onAbort=()=>{ac.abort();reject(Error('inventory_interrupted'));};
      signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();timer=setTimeout(onAbort,timeoutMs);});interrupted.catch(()=>{});
    const live=()=>{assert.ok(!closed&&performance.now()-start<timeoutMs);ac.signal.throwIfAborted();};
    const edge=(kind,source,target,detail={})=>{live();assert.ok(report.edges.length<5000);report.edges.push({kind,source,target,...detail});};
    async function get(path){
      live();assert.ok(report.operations.length<1000);assert.ok(path.startsWith(a+'/workers/'));
      const op={attempt:report.operations.length+1,path,method:'GET',result:'PENDING',receivedBytes:0};report.operations.push(op);persist(op);
      let response,reader,requestTimer,settled=false;const began=performance.now();
      const check=()=>{live();assert.ok(performance.now()-began<20000);};
      const deadline=new Promise((_,reject)=>{requestTimer=setTimeout(()=>{ac.abort();reject(Error('inventory_read_timeout'));},20000);});
      const work=Promise.resolve().then(async()=>{
        check();response=await fetchImpl('https://api.cloudflare.com/client/v4'+path,{method:'GET',headers:{Authorization:'Bearer '+apiToken,Accept:'application/json'},redirect:'error',cache:'no-store',signal:ac.signal});
        if(settled||ac.signal.aborted){cancel(response.body);throw Error('late_inventory_response');}check();op.status=response.status;
        assert.equal(response.status,200);assert.equal(response.redirected,false);assert.match(response.headers.get('Content-Type')??'',/^application\/json(?:;\s*charset=utf-8)?$/i);
        const length=response.headers.get('Content-Length'),encoding=response.headers.get('Content-Encoding');
        assert.ok(encoding===null||['gzip','br','deflate','identity'].includes(encoding));
        if(length!==null)assert.ok(/^(0|[1-9][0-9]*)$/.test(length)&&Number(length)<=2097152);
        reader=response.body.getReader();const chunks=[];let reads=0;
        for(;;){check();assert.ok(++reads<=4096);const v=await reader.read();check();if(v.done)break;assert.ok(v.value instanceof Uint8Array);
          op.receivedBytes+=v.value.byteLength;assert.ok(op.receivedBytes<=2097152);chunks.push(Buffer.from(v.value));}
        if(length!==null&&(!encoding||encoding==='identity'))assert.equal(op.receivedBytes,Number(length));
        const bytes=Buffer.concat(chunks,op.receivedBytes);op.responseSha256=sha(bytes);
        const v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));object(v);assert.equal(v.success,true);
        assert.ok(v.errors==null||Array.isArray(v.errors)&&v.errors.length===0);assert.ok(Object.hasOwn(v,'result'));return v;
      });
      try{const v=await Promise.race([work,deadline,interrupted]);check();op.result='ACK';return v;}
      catch(error){
        op.result='FAILED_OR_UNCERTAIN';
        op.failureClass=ac.signal.aborted?'ABORTED_OR_DEADLINE':'READ_FAILURE';
        op.errorName=/^[A-Za-z]{1,64}$/.test(error?.name??'')?error.name:'UnknownError';
        const code=error?.cause?.code??error?.code;
        op.errorCode=/^[A-Z0-9_]{1,64}$/.test(code??'')?code:null;
        ac.abort();throw Error('inventory_read_failed');
      }
      finally{settled=true;clearTimeout(requestTimer);cancel(reader??response?.body);op.elapsedMs=Math.floor(performance.now()-began);persist({...op});}
    }
    async function parallel(items,fn){let at=0;const results=await Promise.allSettled(Array.from({length:Math.min(4,items.length)},async()=>{
      while(at<items.length){live();const item=items[at++];try{await fn(item);}catch(e){ac.abort();throw e;}}}));
      assert.ok(results.every(r=>r.status==='fulfilled'));live();}
    const uuid=v=>{assert.match(v,/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);return v;};
    const service=v=>{
      object(v);const worker=name(v.id),def=name(v.default_environment?.environment);
      const environments=unique(list(v.environments,20).map(e=>name(e.environment))).sort();
      assert.ok(environments.includes(def));assert.equal(environments.length,1);
      return {worker,defaultEnvironment:def,environments};
    };
    const subdomain=v=>{object(v);assert.equal(typeof v.enabled,'boolean');assert.equal(typeof v.previews_enabled,'boolean');
      return {enabled:v.enabled,previews_enabled:v.previews_enabled};};
    const deployment=v=>{
      const rows=list(object(v).deployments,100);assert.ok(rows.length>0);
      const d=object(rows[0]),versions=list(d.versions,10).map(v=>{
        object(v);assert.ok(typeof v.percentage==='number'&&Number.isFinite(v.percentage)&&v.percentage>=0&&v.percentage<=100);
        return {versionId:uuid(v.version_id),percentage:v.percentage};
      }).sort((l,r)=>l.versionId.localeCompare(r.versionId));
      assert.ok(versions.length>0);unique(versions.map(v=>v.versionId));
      assert.ok(Math.abs(versions.reduce((n,v)=>n+v.percentage,0)-100)<1e-8);
      return {id:uuid(d.id),versions};
    };
    async function versions(base){
      let total,perPage,seen=new Set(),rows=[];
      for(let page=1;;page++){
        live();assert.ok(page<=20);
        const v=await get(base+'/versions?page='+page+'&per_page=100'),items=list(object(v.result).items,100),info=object(v.result_info);
        assert.equal(info.page,page);assert.ok(Number.isSafeInteger(info.per_page)&&info.per_page>0&&info.per_page<=100);
        assert.ok(Number.isSafeInteger(info.total_count)&&info.total_count>=0&&info.total_count<=500);
        assert.equal(info.count,items.length);
        const pages=Math.max(1,Math.ceil(info.total_count/info.per_page));
        if(info.total_pages!==undefined)assert.equal(info.total_pages,pages);
        if(page===1){total=info.total_count;perPage=info.per_page;}else{assert.equal(info.total_count,total);assert.equal(info.per_page,perPage);}
        assert.equal(items.length,Math.min(perPage,Math.max(0,total-(page-1)*perPage)));
        for(const row of items){
          object(row);const versionId=uuid(row.id);assert.ok(!seen.has(versionId));seen.add(versionId);
          assert.ok(Number.isSafeInteger(row.number)&&row.number>0);
          const meta=object(row.metadata);assert.ok(meta.hasPreview===undefined||typeof meta.hasPreview==='boolean');
          rows.push({versionId,number:row.number,hasPreview:meta.hasPreview??null,modifiedOn:optional(meta.modified_on,text)});
        }
        if(page>=pages)break;
      }
      assert.equal(seen.size,total);return rows.sort((l,r)=>l.versionId.localeCompare(r.versionId));
    }
    function bindings(source,rows){
      const types={};unique(list(rows).map(b=>text(object(b).name)));
      for(const b of rows){const type=name(b.type);types[type]=(types[type]??0)+1;
        if(type==='service'){const target=name(b.service);if(targets.includes(target))edge('service',source,target,
          {binding:text(b.name),environment:optional(b.environment),entrypoint:optional(b.entrypoint)});}
        if(type==='d1'){
          const aliases=[b.id,b.database_id].filter(v=>v!=null).map(id);assert.ok(aliases.length>0&&new Set(aliases).size===1);
          if(aliases[0]===db)edge('d1',source,db,{binding:text(b.name)});
        }
        if(type==='durable_object_namespace'&&b.script_name!=null){const target=name(b.script_name);
          if(targets.includes(target))edge('durable-object',source,target,{binding:text(b.name),className:optional(b.class_name),environment:optional(b.environment)});}
        if(type==='dispatch_namespace')edge('dispatch-binding',source,name(b.namespace),{binding:text(b.name)});
      }return types;
    }
    async function worker(workerName){
      const base=a+'/workers/scripts/'+workerName,servicePath=a+'/workers/services/'+workerName;
      const beforeService=service((await get(servicePath)).result);assert.equal(beforeService.worker,workerName);
      const beforeSubdomain=subdomain((await get(base+'/subdomain')).result),beforeDeployment=deployment((await get(base+'/deployments')).result);
      const catalogue=beforeSubdomain.previews_enabled?await versions(base):null;
      if(catalogue!==null)assert.ok(beforeDeployment.versions.every(v=>catalogue.some(row=>row.versionId===v.versionId)));
      const selected=[...new Set([...beforeDeployment.versions.map(v=>v.versionId),...(catalogue??[]).map(v=>v.versionId)])].sort();
      const summary={name:workerName,defaultEnvironment:beforeService.defaultEnvironment,subdomain:beforeSubdomain,
        deployment:beforeDeployment,previewMode:catalogue===null?'DISABLED_ROUTING_OBSERVED':'ALL_LISTED_VERSIONS',
        previewVersionCount:catalogue?.length??null,versionDetails:[],stable:false};
      live();report.workers.push(summary);
      for(const versionId of selected){
        const detail=object((await get(base+'/versions/'+versionId)).result);assert.equal(uuid(detail.id),versionId);
        const resources=object(detail.resources),source='worker:'+workerName+'/'+beforeService.defaultEnvironment+'@'+versionId;
        const types=bindings(source,resources.bindings);live();
        summary.versionDetails.push({versionId,inCurrentDeployment:beforeDeployment.versions.some(v=>v.versionId===versionId),
          previewCandidate:catalogue?.some(v=>v.versionId===versionId)??false,bindingTypes:types,resourcesSha256:sha(JSON.stringify(resources))});
      }
      if(catalogue!==null)assert.deepEqual(await versions(base),catalogue);
      assert.deepEqual(deployment((await get(base+'/deployments')).result),beforeDeployment);
      assert.deepEqual(subdomain((await get(base+'/subdomain')).result),beforeSubdomain);
      assert.deepEqual(service((await get(servicePath)).result),beforeService);
      live();summary.stable=true;
    }
    try{
      live();assert.equal(fs.realpathSync(root),root);for(const p of [resolve(root,'.wrangler'),resolve(root,'.wrangler/staging')]){
        if(!fs.existsSync(p))fs.mkdirSync(p);assert.equal(fs.realpathSync(p),p);assert.ok(fs.lstatSync(p).isDirectory()&&!fs.lstatSync(p).isSymbolicLink());}
      fs.mkdirSync(dir);fd=fs.openSync(resolve(dir,'journal.jsonl'),'wx',0o600);report.result='RUNNING';
      report.startedAt=new Date().toISOString();persist({event:'RESERVED',account,targets});
      const before=list((await get(a+'/workers/scripts')).result,200),names=unique(before.map(w=>name(w.id))).sort();
      assert.ok(targets.every(target=>names.includes(target)));report.workerCount=names.length;
      await parallel(names,worker);
      const after=list((await get(a+'/workers/scripts')).result,200);
      const signature=rows=>rows.map(w=>({id:name(w.id),deployment_id:w.deployment_id,modified_on:w.modified_on})).sort((l,r)=>l.id.localeCompare(r.id));
      assert.deepEqual(unique(after.map(w=>name(w.id))).sort(),names);assert.deepEqual(signature(after),signature(before));
      assert.equal(report.workers.length,names.length);assert.ok(report.workers.every(w=>w.stable));
      report.workers.sort((l,r)=>l.name.localeCompare(r.name));report.edges.sort((l,r)=>JSON.stringify(l).localeCompare(JSON.stringify(r)));
      report.callableDefaultVersionBindingsObserved=true;report.workerCatalogueStable=true;
      report.result='VERSION_BINDINGS_OBSERVED_GAPS_RETAINED';
    }catch{report.result='FAILED_RETAINED';report.callableDefaultVersionBindingsObserved=false;}
    finally{
      clearTimeout(timer);signal?.removeEventListener('abort',onAbort);ac.abort();
      report.finishedAt=new Date().toISOString();report.elapsedMs=Math.floor(performance.now()-start);
      if(fd!==undefined){
        try{persist({event:'FINISHED',result:report.result,callableDefaultVersionBindingsObserved:report.callableDefaultVersionBindingsObserved});}
        catch{report.result='FAILED_RETAINED';report.callableDefaultVersionBindingsObserved=false;}
        closed=true;fs.closeSync(fd);
        try{writeResult();}catch{report.result='FAILED_RETAINED';report.callableDefaultVersionBindingsObserved=false;throw Error('version_inventory_result_not_durable');}
      }
    }
    return structuredClone(report);
  }
  return Object.freeze({run:()=>promise??=execute(),report:()=>structuredClone(report)});
}
