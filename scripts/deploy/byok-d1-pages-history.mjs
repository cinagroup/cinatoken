import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {projectPagesDeploymentLifecycle} from './byok-d1-pages-lifecycle.mjs';

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

/** Enumerates both Pages deployment environments with two complete sweeps.
 * Explicit returned binding maps are projected; missing maps stay UNKNOWN.
 * This read-only catalogue cannot attest complete binding semantics or preflight.
 * No current project configuration is substituted for historical metadata. */
export function createByokD1PagesHistoryInventory({workspace,apiToken,fetchImpl=fetch,timeoutMs=600000,signal}){
  assert.equal(typeof workspace,'string');assert.match(apiToken,/^[\x21-\x7e]{1,512}$/);assert.equal(typeof fetchImpl,'function');
  assert.ok(Number.isInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=600000);assert.ok(signal===undefined||signal instanceof AbortSignal);
  const root=resolve(workspace),dir=resolve(root,'.wrangler/staging/byok-d1-pages-history-reservation');
  let promise,fd,closed=false,sequence=0,previous='0'.repeat(64);
  const report={result:'NOT_RUN',account,targets,stagingDatabase:db,cloudWrites:0,automaticRetries:0,
    discoveryBudget:{timeoutMs,requestLimit:1000,concurrency:4,requestTimeoutMs:20000,responseBytes:2097152,maxProjects:100,maxDeployments:10000},
    historyCatalogueComplete:false,reportedBindingMapsObserved:false,historicalBindingsComplete:false,
    absenceSemanticsVerified:false,allInvocationPathsInventoried:false,fullPreflightPassed:false,snapshotIsAtomic:false,
    visibilityScopeVerified:false,operations:[],projects:[],edges:[],
    uncovered:['PAGES_BINDING_ABSENCE_SEMANTICS','PAGES_OTHER_BINDING_SOURCES','TOKEN_RESOURCE_VISIBILITY',
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
    async function get(path){
      live();assert.ok(report.operations.length<1000);assert.ok(path.startsWith(a+'/pages/projects'));
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
    const base=a+'/pages/projects';let phase='reserve',totalDeployments=0;
    async function pages(path,max,consume){
      let total,perPage,pageCount,seen=new Set();
      for(let page=1;;page++){
        live();assert.ok(page<=200);
        const v=await get(path+(path.includes('?')?'&':'?')+'page='+page),rows=list(v.result,100),info=object(v.result_info);
        assert.equal(info.page,page);assert.ok(Number.isSafeInteger(info.per_page)&&info.per_page>0&&info.per_page<=100);
        assert.ok(Number.isSafeInteger(info.total_count)&&info.total_count>=0&&info.total_count<=max);assert.equal(info.count,rows.length);
        const expectedPages=Math.ceil(info.total_count/info.per_page);
        assert.ok(info.total_pages===expectedPages||(info.total_count===0&&info.total_pages===1));
        if(page===1){total=info.total_count;perPage=info.per_page;pageCount=info.total_pages;}
        else{assert.equal(info.total_count,total);assert.equal(info.per_page,perPage);assert.equal(info.total_pages,pageCount);}
        assert.equal(rows.length,Math.min(perPage,Math.max(0,total-(page-1)*perPage)));
        for(const row of rows){object(row);const key=id(row.id);assert.ok(!seen.has(key));seen.add(key);consume(row);}
        if(page>=pageCount)break;
      }
      assert.equal(seen.size,total);return {count:total,pages:Math.max(1,pageCount)};
    }
    async function projectCatalogue(){
      const rows=[];await pages(base,100,p=>{
        const configs=object(p.deployment_configs);object(configs.production);object(configs.preview);
        assert.ok(p.uses_functions===undefined||typeof p.uses_functions==='boolean');
        rows.push({id:id(p.id),name:name(p.name),usesFunctions:p.uses_functions??null,
          productionScript:name(p.production_script_name),previewScript:name(p.preview_script_name),
          latestDeploymentId:p.latest_deployment==null?null:id(p.latest_deployment.id),
          canonicalDeploymentId:p.canonical_deployment==null?null:id(p.canonical_deployment.id),
          currentConfigurationSha256:sha(JSON.stringify(configs))});
      });unique(rows.map(row=>row.name));return rows.sort((l,r)=>l.name.localeCompare(r.name));
    }
    function deployment(row,project,environment){
      assert.equal(row.project_id,project.id);assert.equal(row.project_name,project.name);assert.equal(row.environment,environment);
      // Skipped historical deployments can return null; unknown never filters a row.
      assert.ok(row.uses_functions==null||typeof row.uses_functions==='boolean');
      assert.ok(row.is_skipped===undefined||typeof row.is_skipped==='boolean');
      const result={id:id(row.id),environment,usesFunctions:row.uses_functions??null,isSkipped:row.is_skipped??null,
        createdOn:text(row.created_on),modifiedOn:text(row.modified_on),metadataSha256:sha(JSON.stringify(row)),
        lifecycle:projectPagesDeploymentLifecycle(row),bindingFields:{}};
      const edges=[],source='pages:'+project.name+'/'+environment+'@'+result.id;
      for(const key of ['services','d1_databases','durable_object_namespaces']){
        if(!Object.hasOwn(row,key)){result.bindingFields[key]={state:'ABSENT_UNVERIFIED',entries:null};continue;}
        if(row[key]===null){result.bindingFields[key]={state:'NULL_UNVERIFIED',entries:null};continue;}
        const map=object(row[key]),entries=Object.entries(map);assert.ok(entries.length<=1000);
        result.bindingFields[key]={state:'EXPLICIT',entries:entries.length};
        for(const [binding,b] of entries){
          text(binding);object(b);
          if(key==='services'){
            const target=name(b.service);
            if(targets.includes(target))edges.push({kind:'pages-service',source,target,binding,environment:optional(b.environment),entrypoint:optional(b.entrypoint)});
          }else if(key==='d1_databases'){
            const aliases=[b.id,b.database_id].filter(v=>v!=null).map(id);assert.ok(aliases.length>0&&new Set(aliases).size===1);
            if(aliases[0]===db)edges.push({kind:'pages-d1',source,target:db,binding});
          }else{
            const aliases=[b.service,b.script_name].filter(v=>v!=null).map(name);assert.ok(new Set(aliases).size<=1);
            if(aliases.length){
              if(targets.includes(aliases[0]))edges.push({kind:'pages-durable-object',source,target:aliases[0],binding,className:optional(b.class_name,text),environment:optional(b.environment)});
            }else edges.push({kind:'pages-unresolved-durable-namespace',source,target:id(b.namespace_id),binding});
          }
        }
      }
      return {result,edges};
    }
    async function history(project,consume){
      const seen=new Set(),stats={};
      for(const environment of ['production','preview']){
        stats[environment]=await pages(base+'/'+project.name+'/deployments?env='+environment,5000,row=>{
          assert.ok(!seen.has(row.id));seen.add(row.id);consume(deployment(row,project,environment));
        });
      }
      return stats;
    }
    try{
      live();assert.equal(fs.realpathSync(root),root);for(const p of [resolve(root,'.wrangler'),resolve(root,'.wrangler/staging')]){
        if(!fs.existsSync(p))fs.mkdirSync(p);assert.equal(fs.realpathSync(p),p);assert.ok(fs.lstatSync(p).isDirectory()&&!fs.lstatSync(p).isSymbolicLink());}
      fs.mkdirSync(dir);fd=fs.openSync(resolve(dir,'journal.jsonl'),'wx',0o600);report.result='RUNNING';
      report.startedAt=new Date().toISOString();persist({event:'RESERVED',account,targets});
      phase='project-catalogue-before';const before=await projectCatalogue();
      report.projects=before.map(project=>({...project,deployments:[],firstSweepComplete:false,stable:false}));
      phase='history-sweep-before';
      await parallel(report.projects,async project=>{
        project.environments=await history(project,({result,edges})=>{
          live();assert.ok(totalDeployments<10000);totalDeployments++;project.deployments.push(result);
          for(const e of edges)edge(e.kind,e.source,e.target,Object.fromEntries(Object.entries(e).filter(([key])=>!['kind','source','target'].includes(key))));
        });
        project.deployments.sort((l,r)=>l.id.localeCompare(r.id));live();project.firstSweepComplete=true;
      });
      phase='history-sweep-after';
      await parallel(report.projects,async project=>{
        const rows=[],stats=await history(project,({result})=>rows.push(result));
        rows.sort((l,r)=>l.id.localeCompare(r.id));assert.deepEqual(rows,project.deployments);assert.deepEqual(stats,project.environments);
        live();project.stable=true;
      });
      phase='project-catalogue-after';assert.deepEqual(await projectCatalogue(),before);live();
      report.projectCatalogueStable=true;report.deploymentCount=totalDeployments;
      report.fieldCoverage={};
      for(const key of ['services','d1_databases','durable_object_namespaces']){
        const fields=report.projects.flatMap(p=>p.deployments.map(d=>d.bindingFields[key]));
        report.fieldCoverage[key]={explicit:fields.filter(f=>f.state==='EXPLICIT').length,
          absentUnverified:fields.filter(f=>f.state==='ABSENT_UNVERIFIED').length,
          nullUnverified:fields.filter(f=>f.state==='NULL_UNVERIFIED').length,
          returnedEntries:fields.reduce((n,f)=>n+(f.entries??0),0)};
      }
      report.edges.sort((l,r)=>JSON.stringify(l).localeCompare(JSON.stringify(r)));
      report.historyCatalogueComplete=true;report.reportedBindingMapsObserved=true;
      report.result='HISTORY_METADATA_OBSERVED_BINDING_SEMANTICS_PENDING';
    }catch(error){
      report.result='FAILED_RETAINED';report.historyCatalogueComplete=false;report.reportedBindingMapsObserved=false;
      report.failedPhase=phase;report.failureName=/^[A-Za-z]{1,64}$/.test(error?.name??'')?error.name:'UnknownError';
    }finally{
      clearTimeout(timer);signal?.removeEventListener('abort',onAbort);ac.abort();
      report.finishedAt=new Date().toISOString();report.elapsedMs=Math.floor(performance.now()-start);
      if(fd!==undefined){
        try{persist({event:'FINISHED',result:report.result,historyCatalogueComplete:report.historyCatalogueComplete});}
        catch{report.result='FAILED_RETAINED';report.historyCatalogueComplete=false;report.reportedBindingMapsObserved=false;}
        closed=true;fs.closeSync(fd);
        try{writeResult();}catch{report.result='FAILED_RETAINED';report.historyCatalogueComplete=false;throw Error('pages_history_result_not_durable');}
      }
    }
    return structuredClone(report);
  }
  return Object.freeze({run:()=>promise??=execute(),report:()=>structuredClone(report)});
}
