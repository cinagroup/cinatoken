import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const target=process.env.BYOK_SOURCE_FREEZE_MODULE;
const {beginByokD1SourceFreeze}=await import(target?pathToFileURL(path.resolve(target)).href:'./byok-d1-source-freeze.mjs');
const sha=v=>createHash('sha256').update(v).digest('hex');
const roles=['receiver','controller','gateway','operator'];
const staging='packages/proxy/scripts/staging/';
const entries={receiver:staging+'byok-d1-maintenance-worker.ts',controller:staging+'byok-d1-maintenance-control-worker.ts',gateway:staging+'byok-d1-gateway-worker.ts',operator:'scripts/deploy/byok-d1-operator.mjs'};
function fixture(){
  const parent=process.env.BYOK_FREEZE_TEST_ROOT??tmpdir();fs.mkdirSync(parent,{recursive:true});
  const root=fs.mkdtempSync(path.join(parent,'byok-source-fixture-'));
  const write=(p,data)=>{fs.mkdirSync(path.dirname(path.join(root,p)),{recursive:true});fs.writeFileSync(path.join(root,p),data);};
  const fixed=['package.json','package-lock.json','pnpm-lock.yaml','tsconfig.json','tsconfig.base.json','scripts/tsconfig.json',
    'packages/core/package.json','packages/core/tsconfig.json','packages/proxy/package.json','packages/proxy/tsconfig.json',staging+'tsconfig.json',
    'scripts/deploy/byok-d1-source-freeze.mjs','node_modules/wrangler/package.json','node_modules/wrangler/bin/wrangler.js',
    'node_modules/wrangler/wrangler-dist/cli.js','node_modules/wrangler/config-schema.json','node_modules/esbuild/package.json',
    'node_modules/esbuild/bin/esbuild','node_modules/esbuild/lib/main.js',
    'node_modules/@esbuild/'+process.platform+'-'+process.arch+'/'+(process.platform==='win32'?'esbuild.exe':'bin/esbuild'),
    ...['maintenance','maintenance-control','gateway'].map(n=>staging+'wrangler.byok-d1-'+n+'.jsonc')];
  for(const p of fixed)write(p,'{}');
  write('node_modules/esbuild/package.json','{"main":"lib/main.js"}');
  write('node_modules/@esbuild/'+process.platform+'-'+process.arch+'/package.json','{}');
  const prior='prior.json',verify='verify.test.mjs',shared='packages/core/src/example.ts';
  write(prior,'{"prior":true}');write(verify,'// fixture verifier');write(shared,'export const shared=1;');
  for(const role of roles)write(entries[role],'export default '+JSON.stringify(role)+';');
  function build(round,mutate){
    const builds={};
    for(const role of roles){
      const base=role==='operator'?'':staging;
      const relative=p=>path.relative(path.join(root,base),path.join(root,p)).split(path.sep).join('/');
      const codePath='.wrangler/staging/'+round+'/'+role+'.mjs';
      const code='export default '+JSON.stringify(role)+';';write(codePath,code);
      const entry=relative(entries[role]),dep=relative(shared);
      const m={inputs:{[entry]:{bytes:Buffer.byteLength(code),imports:[{path:dep,kind:'import-statement'}]},[dep]:{bytes:22,imports:[]}},
        outputs:{[relative(codePath)]:{entryPoint:entry,bytes:Buffer.byteLength(code),imports:[],inputs:{[entry]:{bytesInOutput:code.length}}}}};
      m.inputs[dep].bytes=fs.statSync(path.join(root,shared)).size;
      mutate?.(m,role);const meta='.wrangler/staging/'+round+'/'+role+'.meta.json';write(meta,JSON.stringify(m));builds[role]=meta;
    }return builds;
  }
  const discovery=build('discovery'),builds=build('verified');
  const options={workspace:root,discovery,priorManifest:{path:prior,sha256:sha(fs.readFileSync(path.join(root,prior)))},verificationFiles:[verify]};
  const evidence=[{path:prior,sha256:options.priorManifest.sha256}];
  const start=()=>beginByokD1SourceFreeze(options);
  const seal=g=>g.seal({builds,evidence});
  const editMeta=(role,fn,round='verified')=>{const p='.wrangler/staging/'+round+'/'+role+'.meta.json';const m=JSON.parse(fs.readFileSync(path.join(root,p)));fn(m);write(p,JSON.stringify(m));};
  return {root,write,fixed,prior,verify,shared,build,discovery,builds,options,evidence,start,seal,editMeta};
}
const rejects=fn=>assert.throws(fn,/byok_source_freeze_unconfirmed/);
test('complete two-phase snapshot and fresh revalidation, no execution permission',()=>{
  const f=fixture(),g=f.start(),s=f.seal(g);assert.equal(s.sourceSnapshotCurrent,true);assert.equal(s.fullPreflightPassed,false);
  assert.equal(s.atomicSnapshot,false);assert.equal(s.evidenceSemanticsVerified,false);
  assert.equal(s.builds.length,4);assert.equal(g.assertCurrent(),true);assert.equal(g.report().mustRevalidateBeforeUse,true);
  s.sources.length=0;assert.equal(g.assertCurrent(),true);
});
test('construction and validation write no execution reservation or snapshot files',()=>{
  const f=fixture(),before=fs.readdirSync(f.root),g=f.start();f.seal(g);g.assertCurrent();
  assert.deepEqual(fs.readdirSync(f.root),before);assert.equal(fs.existsSync(path.join(f.root,'.wrangler/staging/byok-d1-execution-reservation')),false);
});
for(const name of ['package-lock.json','pnpm-lock.yaml','tsconfig.base.json','node_modules/esbuild/lib/main.js','node_modules/wrangler/wrangler-dist/cli.js',staging+'wrangler.byok-d1-gateway.jsonc','verify.test.mjs','packages/core/src/example.ts']){
  test('reject source/config/tool/verifier drift: '+name,()=>{const f=fixture(),g=f.start();f.write(name,'different');rejects(()=>f.seal(g));assert.equal(g.report().poisoned,true);});
}
for(const p of ['packages/core/src/package.json','packages/core/src/tsconfig.json','scripts/deploy/tsconfig.jsonc','packages/jsconfig.json']){
  test('new previously absent resolution configuration invalidates: '+p,()=>{const f=fixture(),g=f.start();f.write(p,'{}');rejects(()=>f.seal(g));});
}
test('deleted source cannot reuse evidence',()=>{const f=fixture(),g=f.start();fs.unlinkSync(path.join(f.root,f.shared));rejects(()=>f.seal(g));});
test('same length source mutation is rejected by hash',()=>{const f=fixture(),g=f.start();f.write(f.shared,'export const shared=2;');rejects(()=>f.seal(g));});
test('source changed after seal poisons candidate proof and cannot be revived',()=>{
  const f=fixture(),g=f.start();f.seal(g);f.write(f.shared,'export const shared=2;');rejects(()=>g.assertCurrent());
  f.write(f.shared,'export const shared=1;');rejects(()=>g.assertCurrent());assert.equal(g.report().lastValidationPassed,false);
});
for(const p of ['.wrangler/staging/verified/gateway.mjs','.wrangler/staging/verified/gateway.meta.json','prior.json']){
  test('sealed build/evidence drift rejected: '+p,()=>{const f=fixture(),g=f.start();f.seal(g);f.write(p,'changed');rejects(()=>g.assertCurrent());});
}
test('caller option mutation does not alter captured source set',()=>{const f=fixture(),g=f.start();f.options.verificationFiles.length=0;f.write(f.verify,'changed');rejects(()=>f.seal(g));});
test('missing role rejected',()=>{const f=fixture();delete f.options.discovery.gateway;rejects(f.start);});
test('extra role rejected',()=>{const f=fixture();f.options.discovery.extra=f.discovery.gateway;rejects(f.start);});
test('arbitrary extra options rejected',()=>{const f=fixture();f.options.skip=true;rejects(f.start);});
test('prior manifest must match externally expected hash',()=>{const f=fixture();f.options.priorManifest.sha256='0'.repeat(64);rejects(f.start);});
test('wrong entry point rejected',()=>{const f=fixture();f.editMeta('gateway',m=>Object.values(m.outputs)[0].entryPoint='byok-d1-other.ts','discovery');rejects(f.start);});
test('metafile input byte counts checked against disk',()=>{const f=fixture();f.editMeta('gateway',m=>Object.values(m.inputs)[0].bytes++,'discovery');rejects(f.start);});
test('fresh build cannot omit shared dependency',()=>{const f=fixture(),g=f.start();f.editMeta('gateway',m=>{const [entry,dep]=Object.keys(m.inputs);m.inputs[entry].imports=[];delete m.inputs[dep];});rejects(()=>f.seal(g));});
test('fresh build cannot add previously unfrozen dependency',()=>{const f=fixture(),g=f.start();f.write(staging+'extra.ts','x');f.editMeta('gateway',m=>m.inputs['extra.ts']={bytes:1,imports:[]});rejects(()=>f.seal(g));});
test('unresolved import cannot be hidden in metadata',()=>{const f=fixture();f.editMeta('gateway',m=>Object.values(m.inputs)[0].imports.push({path:'missing.ts'}),'discovery');rejects(f.start);});
for(const bad of ['../outside.meta.json','C:/private/meta.json','meta\\test.json','.wrangler/staging/./x.json']){
  test('metadata path confinement: '+bad,()=>{const f=fixture();f.options.discovery.gateway=bad;rejects(f.start);});
}
test('workspace escaping input rejected',()=>{const f=fixture();f.editMeta('gateway',m=>m.inputs['../../../../../outside.ts']={bytes:1,imports:[]},'discovery');rejects(f.start);});
test('credential file input rejected',()=>{const f=fixture();f.editMeta('gateway',m=>m.inputs['.env']={bytes:1,imports:[]},'discovery');rejects(f.start);});
test('unsupported virtual module rejected',()=>{const f=fixture();f.editMeta('gateway',m=>m.inputs['plugin:remote']={bytes:0,imports:[]},'discovery');rejects(f.start);});
test('unbundled third party import rejected',()=>{const f=fixture();f.editMeta('gateway',m=>Object.values(m.outputs)[0].imports.push({path:'unfrozen-package',external:true}),'discovery');rejects(f.start);});
test('esbuild runtime marker allowed only in input metadata',()=>{const f=fixture();f.editMeta('gateway',m=>Object.values(m.outputs)[0].imports.push({path:'<runtime>',external:true}),'discovery');rejects(f.start);});
test('known Cloudflare sockets external accepted only for Worker builds',()=>{
  const f=fixture();for(const round of ['discovery','verified'])f.editMeta('gateway',m=>Object.values(m.inputs)[0].imports.push({path:'cloudflare:sockets',external:true}),round);
  const g=f.start();f.seal(g);assert.equal(g.assertCurrent(),true);
});
test('host build cannot depend on Workers-only external modules',()=>{const f=fixture();f.editMeta('operator',m=>Object.values(m.inputs)[0].imports.push({path:'cloudflare:sockets',external:true}),'discovery');rejects(f.start);});
test('unexpected executable output rejected',()=>{const f=fixture();f.write('.wrangler/staging/discovery/extra.js','x');f.editMeta('operator',m=>m.outputs['.wrangler/staging/discovery/extra.js']={bytes:1,imports:[],inputs:{}},'discovery');rejects(f.start);});
test('output byte count mismatch rejected',()=>{const f=fixture();f.editMeta('gateway',m=>Object.values(m.outputs)[0].bytes++,'discovery');rejects(f.start);});
test('input directory junction rejected without reading its target',()=>{
  const f=fixture(),dir=path.join(f.root,'packages/core/src'),moved=path.join(f.root,'local-fixture-source');
  fs.renameSync(dir,moved);fs.symlinkSync(moved,dir,process.platform==='win32'?'junction':'dir');rejects(f.start);
});
test('installed Wrangler pnpm junction is confined and its target is frozen',()=>{
  const f=fixture(),dir=path.join(f.root,'node_modules/wrangler'),target=path.join(f.root,'node_modules/.pnpm/wrangler-fixture/node_modules/wrangler');
  fs.mkdirSync(path.dirname(target),{recursive:true});fs.renameSync(dir,target);fs.symlinkSync(target,dir,process.platform==='win32'?'junction':'dir');
  const g=f.start(),s=f.seal(g);assert.ok(s.sources.find(p=>p.path==='node_modules/wrangler/package.json').resolvedPath.includes('.pnpm/'));
  const second=path.join(f.root,'node_modules/.pnpm/wrangler-other/node_modules/wrangler');fs.mkdirSync(path.dirname(second),{recursive:true});fs.cpSync(target,second,{recursive:true});
  fs.unlinkSync(dir);fs.symlinkSync(second,dir,process.platform==='win32'?'junction':'dir');rejects(()=>g.assertCurrent());
});
test('Wrangler alias cannot point outside the pnpm store',()=>{
  const f=fixture(),dir=path.join(f.root,'node_modules/wrangler'),target=path.join(f.root,'other-wrangler');
  fs.renameSync(dir,target);fs.symlinkSync(target,dir,process.platform==='win32'?'junction':'dir');rejects(f.start);
});
test('new compiler resolution shadow invalidates even when original compiler bytes remain',()=>{
  const f=fixture(),g=f.start();f.seal(g);
  f.write('node_modules/wrangler/node_modules/esbuild/package.json','{"main":"lib/main.js"}');
  f.write('node_modules/wrangler/node_modules/esbuild/lib/main.js','{}');
  rejects(()=>g.assertCurrent());
});
test('duplicate evidence rejected',()=>{const f=fixture(),g=f.start();f.evidence.push({...f.evidence[0]});rejects(()=>f.seal(g));});
test('evidence hash mismatch rejected',()=>{const f=fixture(),g=f.start();f.evidence[0].sha256='0'.repeat(64);rejects(()=>f.seal(g));});
test('cannot assert current before sealing',()=>{const f=fixture(),g=f.start();rejects(()=>g.assertCurrent());});
test('cannot seal twice',()=>{const f=fixture(),g=f.start();f.seal(g);rejects(()=>f.seal(g));});
function candidate(f){return {runId:'c02-byok-012345abcdef',priorManifestSha256:f.options.priorManifest.sha256,
  grant:{version:1,runId:'c02-byok-012345abcdef',tokenHash:'c'.repeat(64),schemaSha256:'d'.repeat(64),fencedSchemaSha256:'e'.repeat(64),issuedAt:1,expiresAt:900},
  bundles:Object.fromEntries(roles.filter(r=>r!=='operator').map(r=>{const code=fs.readFileSync(path.join(f.root,'.wrangler/staging/verified/'+r+'.mjs'),'utf8');return [r,{code,sha256:sha(code)}];})),
  priorWorkers:Object.fromEntries(roles.filter(r=>r!=='operator').map(r=>[r,{settingsSha256:'a'.repeat(64),versionId:'00000000-0000-0000-0000-000000000001'}]))};}
test('candidate proof binds full deployment fingerprint and frozen bytes, not live grant eligibility',()=>{
  const f=fixture(),g=f.start();const s=f.seal(g),c=candidate(f),p=g.bindCandidate(c);assert.equal(p.sourceEvidenceSha256,s.evidenceSha256);
  const old=p.candidateSha256;c.grant.tokenHash='f'.repeat(64);assert.notEqual(g.bindCandidate(c).candidateSha256,old);
  assert.equal(g.report().fullPreflightPassed,false);
});
test('candidate bytes with self-consistent but different SHA rejected',()=>{
  const f=fixture(),g=f.start();f.seal(g);const c=candidate(f);c.bundles.gateway.code+='x';c.bundles.gateway.sha256=sha(c.bundles.gateway.code);rejects(()=>g.bindCandidate(c));
});
test('candidate prior manifest mismatch rejected',()=>{const f=fixture(),g=f.start();f.seal(g);const c=candidate(f);c.priorManifestSha256='b'.repeat(64);rejects(()=>g.bindCandidate(c));});
