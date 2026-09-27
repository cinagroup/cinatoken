import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import {builtinModules,createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {byokD1DeploymentFingerprint} from './byok-d1-deployment.mjs';

const sha=v=>createHash('sha256').update(v).digest('hex'), digest=v=>sha(JSON.stringify(v));
const copy=v=>structuredClone(v), hex=/^[a-f0-9]{64}$/;
const roles=['receiver','controller','gateway','operator'];
const staging='packages/proxy/scripts/staging/';
const layout={
  receiver:{base:staging,entry:'byok-d1-maintenance-worker.ts',config:'wrangler.byok-d1-maintenance.jsonc'},
  controller:{base:staging,entry:'byok-d1-maintenance-control-worker.ts',config:'wrangler.byok-d1-maintenance-control.jsonc'},
  gateway:{base:staging,entry:'byok-d1-gateway-worker.ts',config:'wrangler.byok-d1-gateway.jsonc'},
  operator:{base:'',entry:'scripts/deploy/byok-d1-operator.mjs'},
};
const fixedFiles=['package.json','package-lock.json','pnpm-lock.yaml','tsconfig.json','tsconfig.base.json','scripts/tsconfig.json',
  'packages/core/package.json','packages/core/tsconfig.json','packages/proxy/package.json','packages/proxy/tsconfig.json',
  staging+'tsconfig.json','scripts/deploy/byok-d1-source-freeze.mjs',
  'node_modules/wrangler/package.json','node_modules/wrangler/bin/wrangler.js','node_modules/wrangler/wrangler-dist/cli.js',
  'node_modules/wrangler/config-schema.json','node_modules/esbuild/package.json','node_modules/esbuild/bin/esbuild','node_modules/esbuild/lib/main.js',
  ...roles.filter(r=>layout[r].config).map(r=>staging+layout[r].config)];
const builtins=new Set(builtinModules.flatMap(n=>[n,n.startsWith('node:')?n:'node:'+n]));
const exact=(v,keys)=>assert.ok(v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===keys.slice().sort().join(','));
const fold=v=>process.platform==='win32'?v.toLowerCase():v;
const canonical=v=>{
  assert.ok(typeof v==='string'&&v.length>0&&v.length<=1024&&!/[\\:\x00-\x1f]/.test(v)&&!path.posix.isAbsolute(v));
  assert.ok(v.split('/').every(p=>p!==''&&p!=='.'&&p!=='..'&&!/[. ]$/.test(p)));
  return v;
};

/** Two-phase, read-only source/byte guard. Discovery metafiles are supplied by
 * the trusted OFFLINE build driver, not accepted as proof of a passing build.
 * begin() pins inputs before a fresh build; seal() requires the same graph and
 * unchanged sources afterwards. The driver must itself run and verify tests.
 * Evidence hashes bind bytes, not the truth of arbitrary JSON or test coverage.
 * No filesystem lock/atomic snapshot, sandbox attestation, native timing proof,
 * cloud observation or complete preflight is claimed by this component.
 */
export function beginByokD1SourceFreeze(options){
  let workspace,discovery,priorManifest,verificationFiles;
  let poisoned=false, sealed=false, snapshot, baseline, discoveryGraphs, nodeRecord,toolchain,phase='options';
  const toolAliases=new Set(['node_modules/wrangler']);
  const startedAt=new Date().toISOString();
  function guarded(fn){try{assert.equal(poisoned,false);return fn();}catch{poisoned=true;const e=Error('byok_source_freeze_unconfirmed');e.phase=phase;throw e;}}
  function full(relative){canonical(relative);const p=path.resolve(workspace,relative);assert.ok(p.startsWith(workspace+path.sep));return p;}
  function physical(p,optional=false){
    const rel=path.relative(workspace,p);assert.ok(!rel.startsWith('..')&&!path.isAbsolute(rel));
    let current=workspace;const links=[];
    for(const part of rel.split(path.sep)){
      current=path.join(current,part);
      let stat;try{stat=fs.lstatSync(current);}catch(e){if(optional&&e.code==='ENOENT')return false;throw e;}
      if(stat.isSymbolicLink()){
        // This checkout's installed Wrangler is a pnpm directory junction.
        // Admit only that named tool alias, confined to the workspace's pnpm
        // store, and pin its destination as well as every file's real path.
        const alias=path.relative(workspace,current).split(path.sep).join('/');assert.ok(toolAliases.has(alias));
        const target=fs.realpathSync(current),targetRel=path.relative(workspace,target).split(path.sep).join('/');
        canonical(targetRel);assert.ok(targetRel.startsWith('node_modules/.pnpm/'));
        let direct=workspace;for(const component of targetRel.split('/')){direct=path.join(direct,component);assert.equal(fs.lstatSync(direct).isSymbolicLink(),false);}
        links.push({path:alias,target:targetRel});
      }
    }
    const real=fs.realpathSync(p);assert.ok(fold(real).startsWith(fold(workspace+path.sep)));
    if(!links.length)assert.equal(fold(real),fold(p));
    return links.length?{resolvedPath:path.relative(workspace,real).split(path.sep).join('/'),links}:{};
  }
  function read(relative,{optional=false,retain=false,max=134217728,budget}={}){
    const p=full(relative);
    const location=physical(p,optional);if(location===false)return {path:relative,absent:true};
    const fd=fs.openSync(p,'r');
    try{
      const before=fs.fstatSync(fd,{bigint:true});assert.ok(before.isFile()&&before.size<=BigInt(max));
      if(budget){budget.bytes+=Number(before.size);assert.ok(budget.bytes<=268435456);assert.ok(performance.now()-budget.started<60000);}
      const hash=createHash('sha256'), chunk=Buffer.allocUnsafe(65536), chunks=[];let bytes=0;
      for(;;){const n=fs.readSync(fd,chunk,0,chunk.length,null);if(n===0)break;
        bytes+=n;assert.ok(bytes<=max);hash.update(chunk.subarray(0,n));if(retain)chunks.push(Buffer.from(chunk.subarray(0,n)));}
      const after=fs.fstatSync(fd,{bigint:true});
      assert.deepEqual([after.dev,after.ino,after.size,after.mtimeNs,after.ctimeNs],
        [before.dev,before.ino,before.size,before.mtimeNs,before.ctimeNs]);
      assert.deepEqual(physical(p),location);const current=fs.statSync(p,{bigint:true});assert.equal(current.ino,before.ino);assert.equal(current.dev,before.dev);
      assert.equal(bytes,Number(before.size));
      return {path:relative,...location,bytes,sha256:hash.digest('hex'),...(retain?{data:Buffer.concat(chunks,bytes)}:{})};
    }finally{fs.closeSync(fd);}
  }
  function currentNode(){
    // The only non-workspace path accepted is this process's own executable.
    const p=fs.realpathSync(process.execPath),fd=fs.openSync(p,'r');
    try{const before=fs.fstatSync(fd,{bigint:true});assert.ok(before.isFile()&&before.size<=134217728n);
      const h=createHash('sha256'),b=Buffer.allocUnsafe(65536);let bytes=0;
      for(;;){const n=fs.readSync(fd,b,0,b.length,null);if(!n)break;bytes+=n;assert.ok(bytes<=134217728);h.update(b.subarray(0,n));}
      const after=fs.fstatSync(fd,{bigint:true});
      assert.deepEqual([after.dev,after.ino,after.size,after.mtimeNs,after.ctimeNs],[before.dev,before.ino,before.size,before.mtimeNs,before.ctimeNs]);assert.equal(bytes,Number(before.size));
      return {version:process.version,platform:process.platform,arch:process.arch,bytes,sha256:h.digest('hex')};
    }finally{fs.closeSync(fd);}
  }
  const relativeInput=(base,name)=>{
    assert.ok(typeof name==='string'&&name.length<=2048&&!/[\x00-\x1f\\]/.test(name));
    const p=path.resolve(workspace,base,name),rel=path.relative(workspace,p).split(path.sep).join('/');canonical(rel);
    assert.ok(/^(packages|scripts|node_modules)\//.test(rel)&&/\.(?:[cm]?js|[cm]?ts|tsx|json)$/.test(rel));return rel;
  };
  function resolveToolchain(){
    phase='tool-resolution';const files=new Set(),lookups=new Map(),compilers=[];
    // Validate the installed alias before Node's package resolver can follow it.
    physical(full('node_modules/wrangler/wrangler-dist/cli.js'));
    const inside=p=>{const rel=path.relative(workspace,p).split(path.sep).join('/');canonical(rel);assert.ok(rel.startsWith('node_modules/'));return rel;};
    function watch(resolver,name){
      for(const folder of resolver.resolve.paths(name)??[]){
        if(!fold(folder).startsWith(fold(workspace+path.sep)))continue;
        const rel=inside(path.join(folder,name));let stat;
        try{stat=fs.lstatSync(full(rel));}catch(e){if(e.code==='ENOENT'){lookups.set(rel,{path:rel,absent:true});continue;}throw e;}
        if(stat.isSymbolicLink())toolAliases.add(rel);
        const location=physical(full(rel));assert.ok(fs.statSync(full(rel)).isDirectory());lookups.set(rel,{path:rel,...location});
      }
    }
    for(const [role,from] of [['host',full('package.json')],['worker',fs.realpathSync(full('node_modules/wrangler/wrangler-dist/cli.js'))]]){
      const resolver=createRequire(from);watch(resolver,'esbuild');
      const main=resolver.resolve('esbuild'),pkg=resolver.resolve('esbuild/package.json'),esbuild=createRequire(main);
      const platformPackage='@esbuild/'+process.platform+'-'+process.arch;watch(esbuild,platformPackage);
      const binary=esbuild.resolve(platformPackage+'/'+(process.platform==='win32'?'esbuild.exe':'bin/esbuild'));
      const selected=[main,pkg,path.join(path.dirname(pkg),'bin/esbuild'),binary,esbuild.resolve(platformPackage+'/package.json')].map(inside);
      selected.forEach(f=>files.add(f));compilers.push({role,files:selected});
    }
    return {files:[...files].sort(),lookups:[...lookups.values()].sort((a,b)=>a.path.localeCompare(b.path)),compilers};
  }
  function graph(role,metafile){
    phase='graph-'+role;
    const item=read(metafile,{retain:true,max:4194304});const m=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(item.data));
    exact(m,['inputs','outputs']);const entries=Object.entries(m.inputs);assert.ok(entries.length>0&&entries.length<=2000);
    const {base,entry}=layout[role],inputs=[],virtual=[];
    const external=(name,runtime=false)=>builtins.has(name)||role!=='operator'&&['cloudflare:workers','cloudflare:sockets'].includes(name)||runtime&&name==='<runtime>';
    for(const [name,v] of entries){
      assert.ok(Number.isSafeInteger(v.bytes)&&v.bytes>=0&&v.bytes<=8388608&&Array.isArray(v.imports)&&v.imports.length<=1000);
      for(const imp of v.imports)assert.ok(imp.external===true?external(imp.path,true):Object.hasOwn(m.inputs,imp.path));
      if(name.startsWith('node-built-in-modules:')){
        assert.ok(builtins.has(name.slice('node-built-in-modules:'.length)));virtual.push({name,descriptorSha256:digest(v)});
      }else inputs.push({path:relativeInput(base,name),bytes:v.bytes,descriptorSha256:digest(v)});
    }
    assert.equal(new Set(inputs.map(v=>fold(v.path))).size,inputs.length);
    const normalizedEntry=relativeInput(base,entry);assert.ok(inputs.some(v=>v.path===normalizedEntry));
    const outputs=Object.entries(m.outputs);assert.ok(outputs.length>=1&&outputs.length<=2);
    let code;const artifacts=[];
    for(const [name,v] of outputs){
      const absolute=path.resolve(workspace,base,name),relative=path.relative(workspace,absolute).split(path.sep).join('/');canonical(relative);
      assert.ok(relative.startsWith('.wrangler/staging/'));
      assert.ok(Number.isSafeInteger(v.bytes)&&v.bytes>0&&v.bytes<=8388608);
      const artifact=read(relative,{max:8388608});assert.equal(artifact.bytes,v.bytes);artifacts.push(artifact);
      assert.ok(Array.isArray(v.imports));assert.ok(v.imports.every(i=>i.external===true&&external(i.path)));
      if(v.entryPoint!==undefined){assert.equal(code,undefined);assert.equal(relativeInput(base,v.entryPoint),normalizedEntry);
        assert.ok(/\.[cm]?js$/.test(relative));assert.ok(v.bytes<=1048576);code=artifact;
      }else assert.ok(relative.endsWith('.map'));
      for(const key of Object.keys(v.inputs??{}))assert.ok(Object.hasOwn(m.inputs,key));
    }
    assert.ok(code);
    return {role,metafile:{path:metafile,bytes:item.bytes,sha256:item.sha256},code,artifacts,
      graph:{entry:normalizedEntry,inputs:inputs.sort((a,b)=>a.path.localeCompare(b.path)),virtual:virtual.sort((a,b)=>a.name.localeCompare(b.name))}};
  }
  function collectFiles(graphs){
    phase='source-set';
    const resolved=resolveToolchain();if(toolchain)assert.deepEqual(resolved,toolchain);else toolchain=resolved;
    const required=new Set([...fixedFiles,...verificationFiles,priorManifest.path]);
    for(const file of resolved.files)required.add(file);
    required.add('node_modules/@esbuild/'+process.platform+'-'+process.arch+'/'+(process.platform==='win32'?'esbuild.exe':'bin/esbuild'));
    const watched=new Set();
    for(const g of graphs)for(const input of g.graph.inputs){
      required.add(input.path);let dir=path.posix.dirname(input.path);
      // Pin present AND absent config/package candidates along resolution paths.
      for(;;){for(const name of ['package.json','tsconfig.json','tsconfig.jsonc','jsconfig.json'])watched.add(dir==='.'?name:dir+'/'+name);
        if(dir==='.')break;dir=path.posix.dirname(dir);}
    }
    for(const p of required)watched.delete(p);
    assert.ok(required.size+watched.size<=6000);
    const budget={started:performance.now(),bytes:0};
    const values=[...required].sort().map(p=>{phase='required-file';return read(p,{budget});});
    phase='optional-configs';for(const p of [...watched].sort())values.push(read(p,{optional:true,max:1048576,budget}));
    for(const g of graphs)for(const input of g.graph.inputs)assert.equal(values.find(v=>v.path===input.path).bytes,input.bytes);
    return values.sort((a,b)=>a.path.localeCompare(b.path));
  }
  guarded(()=>{
    exact(options,['workspace','discovery','priorManifest','verificationFiles']);
    ({discovery,priorManifest,verificationFiles}=copy(options));workspace=path.resolve(options.workspace);
    assert.equal(fold(fs.realpathSync(workspace)),fold(workspace));assert.equal(fs.lstatSync(workspace).isSymbolicLink(),false);
    exact(discovery,roles);exact(priorManifest,['path','sha256']);assert.match(priorManifest.sha256,hex);canonical(priorManifest.path);
    assert.ok(Array.isArray(verificationFiles)&&verificationFiles.length>0&&verificationFiles.length<=100);
    verificationFiles.forEach(canonical);assert.equal(new Set(verificationFiles.map(fold)).size,verificationFiles.length);
    discoveryGraphs=roles.map(r=>graph(r,discovery[r]));
    baseline=collectFiles(discoveryGraphs);
    assert.equal(baseline.find(f=>f.path===priorManifest.path).sha256,priorManifest.sha256);
    phase='node';nodeRecord=currentNode();
  });
  function recheck(){
    assert.deepEqual(collectFiles(discoveryGraphs),baseline);assert.deepEqual(currentNode(),nodeRecord);
    if(snapshot){
      for(const artifact of [...snapshot.builds.flatMap(b=>[b.metafile,...b.artifacts]),...snapshot.evidence])assert.deepEqual(read(artifact.path,{max:8388608}),artifact);
    }
    return true;
  }
  return Object.freeze({
    seal({builds,evidence}){return guarded(()=>{
      assert.equal(sealed,false);exact(builds,roles);
      assert.ok(Array.isArray(evidence)&&evidence.length>0&&evidence.length<=100);
      recheck();const built=roles.map(r=>graph(r,builds[r]));
      assert.deepEqual(built.map(b=>b.graph),discoveryGraphs.map(b=>b.graph));
      assert.equal(new Set(built.flatMap(b=>[b.metafile.path,...b.artifacts.map(a=>a.path)])).size,built.reduce((n,b)=>n+b.artifacts.length+1,0));
      const records=evidence.map(e=>{exact(e,['path','sha256']);assert.match(e.sha256,hex);const r=read(e.path,{max:8388608});assert.equal(r.sha256,e.sha256);return r;});
      assert.equal(new Set(records.map(r=>fold(r.path))).size,records.length);
      recheck();
      snapshot={version:1,startedAt,sealedAt:new Date().toISOString(),node:nodeRecord,toolchain,priorManifest,
        sources:baseline,builds:built,evidence:records,sourceSnapshotCurrent:true,
        atomicSnapshot:false,buildExecutionIndependentlyAttested:false,evidenceSemanticsVerified:false,
        fullPreflightPassed:false};
      sealed=true;recheck();return copy({...snapshot,evidenceSha256:digest(snapshot)});
    });},
    assertCurrent(){return guarded(()=>{assert.equal(sealed,true);return recheck();});},
    bindCandidate(candidate){return guarded(()=>{
      assert.equal(sealed,true);recheck();const candidateSha256=byokD1DeploymentFingerprint(candidate);
      assert.equal(candidate.priorManifestSha256,priorManifest.sha256);
      for(const role of roles.filter(r=>r!=='operator')){
        const built=snapshot.builds.find(b=>b.role===role);assert.equal(candidate.bundles[role].sha256,built.code.sha256);
        assert.equal(sha(Buffer.from(candidate.bundles[role].code,'utf8')),built.code.sha256);
      }
      return Object.freeze({runId:candidate.runId,candidateSha256,priorManifestSha256:priorManifest.sha256,sourceEvidenceSha256:digest(snapshot)});
    });},
    report(){return copy({sealed,poisoned,...(snapshot?{evidenceSha256:digest(snapshot),lastValidationPassed:!poisoned}:{}),mustRevalidateBeforeUse:true,fullPreflightPassed:false});},
  });
}
