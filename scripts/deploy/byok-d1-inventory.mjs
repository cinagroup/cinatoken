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

/** Discovery only. This does not authorize deployment or attest exclusivity.
 * Covers CURRENT account-visible defaults/service environments, Pages project
 * configuration, zone routes, queues and workflows. Historical Pages URLs,
 * version-specific previews/split deployments and visibility scope remain open.
 * Raw configuration/environment values are never persisted or returned.
 */
export function createByokD1Inventory({workspace,apiToken,fetchImpl=fetch,timeoutMs=120000,signal}){
  assert.equal(typeof workspace,'string');assert.match(apiToken,/^[\x21-\x7e]{1,512}$/);assert.equal(typeof fetchImpl,'function');
  assert.ok(Number.isInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=120000);assert.ok(signal===undefined||signal instanceof AbortSignal);
  const root=resolve(workspace),dir=resolve(root,'.wrangler/staging/byok-d1-inventory-reservation');
  let promise,fd,closed=false,sequence=0,previous='0'.repeat(64);
  const report={result:'NOT_RUN',account,targets,stagingDatabase:db,cloudWrites:0,automaticRetries:0,
    currentConfigurationInventoryComplete:false,allInvocationPathsInventoried:false,fullPreflightPassed:false,
    snapshotIsAtomic:false,visibilityScopeVerified:false,operations:[],catalogues:{},workers:[],edges:[],
    uncovered:['TOKEN_RESOURCE_VISIBILITY','ACTIVE_AND_PREVIEW_VERSION_BINDINGS','HISTORICAL_PAGES_DEPLOYMENT_BINDINGS',
      'DISPATCH_NAMESPACES','NON_CATALOGUED_INVOCATION_SOURCES','CURRENT_INGRESS_CLOSURE','IN_FLIGHT_SQL_AND_EXTERNAL_D1_CLIENTS']};
  function persist(v){assert.ok(fd!==undefined&&!closed&&sequence<802);const row={sequence:sequence+1,previous,...v},digest=sha(JSON.stringify(row));
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
    const edge=(kind,source,target,detail={})=>{live();assert.ok(report.edges.length<2000);report.edges.push({kind,source,target,...detail});};
    async function get(path){
      live();assert.ok(report.operations.length<400);assert.ok(path.startsWith(a+'/')||path.startsWith('/zones?account.id='+account)||/^\/zones\/[a-f0-9]{32}\/workers\/routes$/.test(path));
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
      catch{op.result='FAILED_OR_UNCERTAIN';ac.abort();throw Error('inventory_read_failed');}
      finally{settled=true;clearTimeout(requestTimer);cancel(reader??response?.body);op.elapsedMs=Math.floor(performance.now()-began);persist({...op});}
    }
    async function parallel(items,fn){let at=0;const results=await Promise.allSettled(Array.from({length:Math.min(4,items.length)},async()=>{
      while(at<items.length){live();const item=items[at++];try{await fn(item);}catch(e){ac.abort();throw e;}}}));
      assert.ok(results.every(r=>r.status==='fulfilled'));live();}
    async function paged(key,path,perPage,identify,consume){let total,pages,actualPer,seen=new Set(),page=1;
      for(;;){live();assert.ok(page<=20);const sep=path.includes('?')?'&':'?';
        const v=await get(path+sep+'page='+page+(perPage===undefined?'':'&per_page='+perPage)),rows=list(v.result),info=object(v.result_info);
        assert.equal(info.page,page);assert.ok(Number.isInteger(info.per_page)&&info.per_page>0&&info.per_page<=1000);
        assert.equal(info.count,rows.length);assert.ok(Number.isInteger(info.total_count)&&info.total_count>=0&&info.total_count<=1000);
        assert.ok(Number.isInteger(info.total_pages)&&info.total_pages>=0&&info.total_pages<=20);
        assert.ok(info.total_pages===Math.ceil(info.total_count/info.per_page)||(info.total_count===0&&info.total_pages===1));
        if(page===1){total=info.total_count;pages=info.total_pages;actualPer=info.per_page;}else{assert.equal(info.total_count,total);assert.equal(info.total_pages,pages);assert.equal(info.per_page,actualPer);}
        assert.equal(rows.length,Math.min(actualPer,Math.max(0,total-(page-1)*actualPer)));
        for(const row of rows){object(row);const identity=identify(row);assert.ok(!seen.has(identity));seen.add(identity);consume(row);}
        if(page>=pages)break;page++;
      }assert.equal(seen.size,total);report.catalogues[key]={count:total,pagesRead:page,perPage:actualPer,complete:true};
    }
    function bindings(source,rows){for(const b of list(rows)){object(b);const type=name(b.type);
      if(type==='service'){const target=name(b.service);if(targets.includes(target))edge('service',source,target,{binding:text(b.name),environment:optional(b.environment),entrypoint:optional(b.entrypoint)});}
      if(type==='d1'){const target=id(b.id);if(target===db)edge('d1',source,target,{binding:text(b.name)});}
      if(type==='durable_object_namespace'&&b.script_name!=null){const target=name(b.script_name);if(targets.includes(target))edge('durable-object',source,target,{binding:text(b.name),className:optional(b.class_name),environment:optional(b.environment)});}
      if(type==='dispatch_namespace')edge('dispatch-binding',source,name(b.namespace),{binding:text(b.name)});
    }}
    function tails(source,rows){for(const b of list(rows??[])){object(b);const target=name(b.service);if(targets.includes(target))edge('tail',source,target,{environment:optional(b.environment),namespace:optional(b.namespace)});}}
    try{
      live();assert.equal(fs.realpathSync(root),root);for(const p of [resolve(root,'.wrangler'),resolve(root,'.wrangler/staging')]){
        if(!fs.existsSync(p))fs.mkdirSync(p);assert.equal(fs.realpathSync(p),p);assert.ok(fs.lstatSync(p).isDirectory()&&!fs.lstatSync(p).isSymbolicLink());}
      fs.mkdirSync(dir);fd=fs.openSync(resolve(dir,'journal.jsonl'),'wx',0o600);report.result='RUNNING';report.startedAt=new Date().toISOString();persist({event:'RESERVED',account,targets});
      // Scripts and routes are documented single-page APIs. No invented pagination.
      const before=list((await get(a+'/workers/scripts')).result,200);const names=unique(before.map(w=>name(w.id))).sort();
      assert.ok(targets.every(t=>names.includes(t)));report.catalogues.workers={count:names.length,complete:true,mode:'documented-single-page'};
      await parallel(names,async worker=>{
        const service=object((await get(a+'/workers/services/'+worker)).result);assert.equal(service.id,worker);
        const def=name(service.default_environment?.environment),envs=unique(list(service.environments,20).map(e=>name(e.environment)));
        assert.ok(envs.includes(def));const summary={name:worker,defaultEnvironment:def,environments:envs.sort(),settings:[]};
        for(const environment of envs){live();const source='worker:'+worker+'/'+environment;
          if(environment===def){const settings=object((await get(a+'/workers/scripts/'+worker+'/settings')).result);bindings(source,settings.bindings);tails(source,settings.tail_consumers);tails(source,settings.streaming_tail_consumers);
            summary.settings.push({environment,sha256:sha(JSON.stringify(settings))});
          }else{const base=a+'/workers/services/'+worker+'/environments/'+environment;
            const metadata=object((await get(base)).result),rows=(await get(base+'/bindings')).result;bindings(source,rows);
            tails(source,metadata.script?.tail_consumers);tails(source,metadata.script?.streaming_tail_consumers);summary.settings.push({environment,sha256:sha(JSON.stringify({metadata,bindings:rows}))});}
        }
        if(targets.includes(worker)){const script=object(service.default_environment.script);summary.handlers=list(script.handlers).map(name);
          summary.namedHandlers=list(script.named_handlers??[]).map(h=>({name:name(h.name),handlers:list(h.handlers).map(name)}));}
        live();report.workers.push(summary);
      });
      await paged('pages',a+'/pages/projects',undefined,p=>id(p.id),p=>{const source='pages:'+name(p.name),configs=object(p.deployment_configs);
        for(const env of ['production','preview']){const config=object(configs[env]);
          for(const [binding,b] of Object.entries(object(config.services??{}))){object(b);const target=name(b.service);if(targets.includes(target))edge('pages-service',source+'/'+env,target,{binding:text(binding),environment:optional(b.environment),entrypoint:optional(b.entrypoint)});}
          for(const [binding,b] of Object.entries(object(config.d1_databases??{}))){object(b);const target=id(b.id);if(target===db)edge('pages-d1',source+'/'+env,target,{binding:text(binding)});}
        }});
      const zones=[];await paged('zones','/zones?account.id='+account,50,z=>id(z.id),z=>{assert.equal(z.account?.id,account);zones.push(z.id);});
      await parallel(zones,async zone=>{const rows=list((await get('/zones/'+zone+'/workers/routes')).result);unique(rows.map(r=>id(r.id)));
        for(const r of rows){if(r.script==null)continue;const target=name(r.script);if(targets.includes(target))edge('zone-route','zone:'+zone,target,{routeId:r.id,pattern:text(r.pattern)});}});
      report.catalogues.routes={zonesRead:zones.length,complete:true,mode:'documented-single-page-per-zone'};
      await paged('queues',a+'/queues',100,q=>id(q.queue_id),q=>{const consumers=list(q.consumers,100);assert.equal(q.consumers_total_count,consumers.length);
        for(const c of consumers){object(c);assert.ok(['worker','http_pull'].includes(c.type));if(c.type!=='worker')continue;
          const aliases=[c.script,c.service,c.script_name].filter(v=>v!=null).map(name);assert.ok(aliases.length>0&&new Set(aliases).size===1);
          const target=aliases[0];if(targets.includes(target))edge('queue-consumer','queue:'+q.queue_id,target,{environment:optional(c.environment)});}});
      await paged('workflows',a+'/workflows',100,w=>name(w.id),w=>{const target=name(w.script_name);if(targets.includes(target))edge('workflow','workflow:'+name(w.id),target,{className:name(w.class_name)});});
      const after=list((await get(a+'/workers/scripts')).result,200);assert.deepEqual(unique(after.map(w=>name(w.id))).sort(),names);
      const signature=rows=>rows.map(w=>({id:w.id,deployment_id:w.deployment_id,modified_on:w.modified_on})).sort((l,r)=>l.id.localeCompare(r.id));
      assert.deepEqual(signature(after),signature(before));report.workerCatalogueStable=true;
      report.workers.sort((l,r)=>l.name.localeCompare(r.name));report.edges.sort((l,r)=>JSON.stringify(l).localeCompare(JSON.stringify(r)));
      report.currentConfigurationInventoryComplete=true;report.result='CURRENT_CONFIGURATION_OBSERVED_GAPS_RETAINED';
    }catch{report.result='FAILED_RETAINED';report.currentConfigurationInventoryComplete=false;}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);ac.abort();report.finishedAt=new Date().toISOString();report.elapsedMs=Math.floor(performance.now()-start);
      if(fd!==undefined){try{persist({event:'FINISHED',result:report.result,currentConfigurationInventoryComplete:report.currentConfigurationInventoryComplete});}
        catch{report.result='FAILED_RETAINED';report.currentConfigurationInventoryComplete=false;}closed=true;fs.closeSync(fd);
        try{writeResult();}catch{report.result='FAILED_RETAINED';report.currentConfigurationInventoryComplete=false;throw Error('inventory_result_not_durable');}}}
    return structuredClone(report);
  }
  return Object.freeze({run:()=>promise??=execute(),report:()=>structuredClone(report)});
}
