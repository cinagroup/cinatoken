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

/** Enumerates both Pages backing Worker names without filtering by current Functions flags.
 * Reads all listed version binding arrays, including old versions, with stable catalogues.
 * Missing scripts and Pages-to-Worker mapping remain explicit unresolved coverage.
 * Read-only discovery only: never a preflight or deployment authorization. */
export function createByokD1PagesWorkerVersions({workspace,apiToken,fetchImpl=fetch,timeoutMs=600000,signal}){
  assert.equal(typeof workspace,'string');assert.match(apiToken,/^[\x21-\x7e]{1,512}$/);assert.equal(typeof fetchImpl,'function');
  assert.ok(Number.isInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=600000);assert.ok(signal===undefined||signal instanceof AbortSignal);
  const root=resolve(workspace),dir=resolve(root,'.wrangler/staging/byok-d1-pages-worker-versions-reservation');
  let promise,fd,closed=false,sequence=0,previous='0'.repeat(64);
  const report={result:'NOT_RUN',account,targets,stagingDatabase:db,cloudWrites:0,automaticRetries:0,
    discoveryBudget:{timeoutMs,requestLimit:1000,concurrency:4,requestTimeoutMs:20000,responseBytes:2097152,maxProjects:100,maxVersionsPerScript:500},
    listedVersionBindingsObserved:false,historicalBindingsComplete:false,pagesDeploymentMappingComplete:false,
    allInvocationPathsInventoried:false,fullPreflightPassed:false,snapshotIsAtomic:false,visibilityScopeVerified:false,
    operations:[],projects:[],scripts:[],edges:[],
    uncovered:['PAGES_DEPLOYMENT_TO_WORKER_VERSION_MAPPING','MISSING_BACKING_SCRIPT_SEMANTICS','TOKEN_RESOURCE_VISIBILITY',
      'ZONE_ROUTES','DISPATCH_NAMESPACES','CURRENT_INGRESS_CLOSURE','IN_FLIGHT_SQL_AND_EXTERNAL_D1_CLIENTS']};
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
    async function get(path,{allowMissing=false}={}){
      live();assert.ok(report.operations.length<1000);assert.ok(path.startsWith(a+'/pages/projects')||path.startsWith(a+'/workers/scripts/'));
      const op={attempt:report.operations.length+1,path,method:'GET',result:'PENDING',receivedBytes:0};report.operations.push(op);persist(op);
      let response,reader,requestTimer,settled=false;const began=performance.now();
      const check=()=>{live();assert.ok(performance.now()-began<20000);};
      const deadline=new Promise((_,reject)=>{requestTimer=setTimeout(()=>{ac.abort();reject(Error('inventory_read_timeout'));},20000);});
      const work=Promise.resolve().then(async()=>{
        check();response=await fetchImpl('https://api.cloudflare.com/client/v4'+path,{method:'GET',headers:{Authorization:'Bearer '+apiToken,Accept:'application/json'},redirect:'error',cache:'no-store',signal:ac.signal});
        if(settled||ac.signal.aborted){cancel(response.body);throw Error('late_inventory_response');}check();op.status=response.status;
        assert.ok(response.status===200||(allowMissing&&response.status===404));assert.equal(response.redirected,false);assert.match(response.headers.get('Content-Type')??'',/^application\/json(?:;\s*charset=utf-8)?$/i);
        const length=response.headers.get('Content-Length'),encoding=response.headers.get('Content-Encoding');
        assert.ok(encoding===null||['gzip','br','deflate','identity'].includes(encoding));
        if(length!==null)assert.ok(/^(0|[1-9][0-9]*)$/.test(length)&&Number(length)<=2097152);
        reader=response.body.getReader();const chunks=[];let reads=0;
        for(;;){check();assert.ok(++reads<=4096);const v=await reader.read();check();if(v.done)break;assert.ok(v.value instanceof Uint8Array);
          op.receivedBytes+=v.value.byteLength;assert.ok(op.receivedBytes<=2097152);chunks.push(Buffer.from(v.value));}
        if(length!==null&&(!encoding||encoding==='identity'))assert.equal(op.receivedBytes,Number(length));
        const bytes=Buffer.concat(chunks,op.receivedBytes);op.responseSha256=sha(bytes);
        const v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));object(v);assert.equal(v.success,response.status===200);
        if(response.status===200)assert.ok(v.errors==null||Array.isArray(v.errors)&&v.errors.length===0);
        else{assert.ok(Array.isArray(v.errors)&&v.errors.length>0&&v.errors.length<=20);
          assert.ok(v.errors.every(e=>Number.isSafeInteger(e.code)&&e.code>0));assert.equal(v.result,null);}
        assert.ok(Object.hasOwn(v,'result'));return {...v,httpStatus:response.status};
      });
      try{const v=await Promise.race([work,deadline,interrupted]);check();op.result=v.httpStatus===404?'ACK_NOT_FOUND_UNVERIFIED':'ACK';return v;}
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
    const base=a+'/pages/projects';let phase='reserve';
    async function catalogue(){
      let total,perPage,rows=[];const ids=new Set(),names=new Set(),scripts=new Set();
      for(let page=1;;page++){
        assert.ok(page<=100);const v=await get(base+'?page='+page),items=list(v.result,100),info=object(v.result_info);
        assert.equal(info.page,page);assert.equal(info.count,items.length);
        assert.ok(Number.isSafeInteger(info.per_page)&&info.per_page>0&&info.per_page<=100);
        assert.ok(Number.isSafeInteger(info.total_count)&&info.total_count>=0&&info.total_count<=100);
        const pages=Math.ceil(info.total_count/info.per_page);assert.ok(info.total_pages===pages||(!pages&&info.total_pages===1));
        if(page===1){total=info.total_count;perPage=info.per_page;}else{assert.equal(info.total_count,total);assert.equal(info.per_page,perPage);}
        assert.equal(items.length,Math.min(perPage,Math.max(0,total-(page-1)*perPage)));
        for(const p of items){
          object(p);const configs=object(p.deployment_configs);object(configs.production);object(configs.preview);
          const row={id:id(p.id),name:name(p.name),productionScript:name(p.production_script_name),previewScript:name(p.preview_script_name),
            subdomain:p.subdomain==null?null:text(p.subdomain),configurationSha256:sha(JSON.stringify(configs)),
            metadataSha256:sha(JSON.stringify({modified_on:p.modified_on,latest:p.latest_deployment?.id,canonical:p.canonical_deployment?.id}))};
          if(row.subdomain!==null)assert.match(row.subdomain,/^[a-z0-9-]+\.pages\.dev$/);
          assert.ok(!ids.has(row.id)&&!names.has(row.name));ids.add(row.id);names.add(row.name);
          for(const script of [row.productionScript,row.previewScript]){assert.ok(!scripts.has(script));scripts.add(script);}
          rows.push(row);
        }
        if(page>=pages)break;
      }
      assert.equal(rows.length,total);return rows.sort((l,r)=>l.name.localeCompare(r.name));
    }
    async function versions(script){
      const path=a+'/workers/scripts/'+script;let total,perPage,rows=[];const seen=new Set();
      for(let page=1;;page++){
        live();assert.ok(page<=20);const v=await get(path+'/versions?page='+page+'&per_page=100',{allowMissing:page===1});
        if(v.httpStatus===404)return {state:'NOT_FOUND_UNVERIFIED',errorCodes:v.errors.map(e=>e.code),rows:null};
        const items=list(object(v.result).items,100),info=object(v.result_info);
        assert.equal(info.page,page);assert.equal(info.count,items.length);
        assert.ok(Number.isSafeInteger(info.per_page)&&info.per_page>0&&info.per_page<=100);
        assert.ok(Number.isSafeInteger(info.total_count)&&info.total_count>=0&&info.total_count<=500);
        const pages=Math.max(1,Math.ceil(info.total_count/info.per_page));
        if(info.total_pages!==undefined)assert.ok(info.total_pages===pages||(!info.total_count&&info.total_pages===0));
        if(page===1){total=info.total_count;perPage=info.per_page;}else{assert.equal(info.total_count,total);assert.equal(info.per_page,perPage);}
        assert.equal(items.length,Math.min(perPage,Math.max(0,total-(page-1)*perPage)));
        for(const row of items){
          object(row);const key=id(row.id);assert.ok(!seen.has(key));seen.add(key);
          assert.ok(Number.isSafeInteger(row.number)&&row.number>0);const meta=object(row.metadata);
          for(const key of ['has_preview','hasPreview'])assert.ok(meta[key]===undefined||typeof meta[key]==='boolean');
          if(meta.has_preview!==undefined&&meta.hasPreview!==undefined)assert.equal(meta.has_preview,meta.hasPreview);
          rows.push({id:key,number:row.number,metadataSha256:sha(JSON.stringify(row))});
        }
        if(page>=pages)break;
      }
      assert.equal(rows.length,total);return {state:'LISTED',rows:rows.sort((l,r)=>l.id.localeCompare(r.id))};
    }
    function bindings(source,values,project){
      const rows=list(values),types={};unique(rows.map(b=>text(object(b).name)));let urlAssociation={state:'ABSENT'};
      for(const b of rows){
        const type=name(b.type);types[type]=(types[type]??0)+1;
        if(type==='service'){
          const target=name(b.service);if(targets.includes(target))edge('pages-worker-service',source,target,
            {binding:text(b.name),environment:optional(b.environment),entrypoint:optional(b.entrypoint)});
        }
        if(type==='d1'){
          const aliases=[b.id,b.database_id].filter(v=>v!=null).map(id);assert.ok(aliases.length>0&&new Set(aliases).size===1);
          if(aliases[0]===db)edge('pages-worker-d1',source,db,{binding:text(b.name)});
        }
        if(type==='durable_object_namespace'){
          if(b.script_name!=null){const target=name(b.script_name);
            if(targets.includes(target))edge('pages-worker-durable-object',source,target,{binding:text(b.name),className:optional(b.class_name,text),environment:optional(b.environment)});
          }else edge('pages-worker-unresolved-durable-object',source,source,{binding:text(b.name)});
        }
        if(type==='dispatch_namespace')edge('pages-worker-dispatch',source,name(b.namespace),{binding:text(b.name)});
        if(type==='plain_text'&&b.name==='CF_PAGES_URL'){
          assert.ok(typeof b.text==='string'&&b.text.length<=2048);urlAssociation={state:'UNMATCHED',sha256:sha(b.text)};
          let u;try{u=new URL(b.text);}catch{continue;}
          if(u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&u.pathname==='/'&&!u.search&&!u.hash&&project.subdomain){
            if(u.hostname===project.subdomain)urlAssociation.state='PROJECT_ALIAS_ONLY';
            else if(u.hostname.endsWith('.'+project.subdomain)){
              const prefix=u.hostname.slice(0,-project.subdomain.length-1);
              if(/^[a-f0-9]{8}$/.test(prefix))urlAssociation={state:'SHORT_ID_CANDIDATE_ONLY',shortId:prefix,sha256:sha(b.text)};
            }
          }
        }
      }
      return {types,urlAssociation};
    }
    async function script(item){
      const summary={...item,catalogueState:'NOT_READ',versions:[],stable:false};live();report.scripts.push(summary);
      const before=await versions(item.name);live();summary.catalogueState=before.state;
      if(before.state==='NOT_FOUND_UNVERIFIED')summary.errorCodes=before.errorCodes;
      else{
        summary.listedCount=before.rows.length;
        for(const selected of before.rows){
          const detail=object((await get(a+'/workers/scripts/'+item.name+'/versions/'+selected.id)).result);
          assert.equal(id(detail.id),selected.id);assert.equal(detail.number,selected.number);
          const resources=object(detail.resources),source='pages-worker:'+item.name+'@'+selected.id;
          const projection=bindings(source,resources.bindings,item);
          live();summary.versions.push({id:selected.id,number:selected.number,bindingTypes:projection.types,urlAssociation:projection.urlAssociation,
            resourcesSha256:sha(JSON.stringify(resources)),metadataSha256:sha(JSON.stringify(detail.metadata??null))});
        }
      }
      assert.deepEqual(await versions(item.name),before);live();summary.stable=true;
    }
    try{
      live();assert.equal(fs.realpathSync(root),root);for(const p of [resolve(root,'.wrangler'),resolve(root,'.wrangler/staging')]){
        if(!fs.existsSync(p))fs.mkdirSync(p);assert.equal(fs.realpathSync(p),p);assert.ok(fs.lstatSync(p).isDirectory()&&!fs.lstatSync(p).isSymbolicLink());}
      fs.mkdirSync(dir);fd=fs.openSync(resolve(dir,'journal.jsonl'),'wx',0o600);report.result='RUNNING';
      report.startedAt=new Date().toISOString();persist({event:'RESERVED',account,targets});
      phase='catalogue-before';const before=await catalogue();report.projects=before;
      const selected=before.flatMap(p=>[
        {name:p.productionScript,project:p.name,projectId:p.id,subdomain:p.subdomain,environment:'production'},
        {name:p.previewScript,project:p.name,projectId:p.id,subdomain:p.subdomain,environment:'preview'}]);
      phase='script-versions';await parallel(selected,script);
      phase='catalogue-after';assert.deepEqual(await catalogue(),before);live();
      assert.equal(report.scripts.length,selected.length);assert.ok(report.scripts.every(s=>s.stable));
      report.scripts.sort((l,r)=>l.name.localeCompare(r.name));report.edges.sort((l,r)=>JSON.stringify(l).localeCompare(JSON.stringify(r)));
      report.versionCount=report.scripts.reduce((n,s)=>n+s.versions.length,0);
      report.missingScripts=report.scripts.filter(s=>s.catalogueState==='NOT_FOUND_UNVERIFIED').map(s=>s.name);
      report.projectCatalogueStable=true;report.listedVersionBindingsObserved=true;
      report.result='LISTED_PAGES_WORKER_BINDINGS_OBSERVED_MAPPING_PENDING';
    }catch(error){
      report.result='FAILED_RETAINED';report.listedVersionBindingsObserved=false;report.failedPhase=phase;
      report.failureName=/^[A-Za-z]{1,64}$/.test(error?.name??'')?error.name:'UnknownError';
    }finally{
      clearTimeout(timer);signal?.removeEventListener('abort',onAbort);ac.abort();
      report.finishedAt=new Date().toISOString();report.elapsedMs=Math.floor(performance.now()-start);
      if(fd!==undefined){
        try{persist({event:'FINISHED',result:report.result,listedVersionBindingsObserved:report.listedVersionBindingsObserved});}
        catch{report.result='FAILED_RETAINED';report.listedVersionBindingsObserved=false;}
        closed=true;fs.closeSync(fd);
        try{writeResult();}catch{report.result='FAILED_RETAINED';report.listedVersionBindingsObserved=false;throw Error('pages_worker_versions_result_not_durable');}
      }
    }
    return structuredClone(report);
  }
  return Object.freeze({run:()=>promise??=execute(),report:()=>structuredClone(report)});
}

