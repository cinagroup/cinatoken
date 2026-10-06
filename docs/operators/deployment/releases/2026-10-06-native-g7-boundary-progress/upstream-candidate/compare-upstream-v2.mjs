import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
const root=path.dirname(new URL(import.meta.url).pathname.replace(/^\/(C:)/,'$1'));
const repo='C:/cinagroup/cinatoken';
const upstream='QuantumNous/new-api';
const firstTracked='66ef5a698c0bb16aa1f2c490c79b6a06bdb5b33b';
const hash=b=>createHash('sha256').update(b).digest('hex');
const blob=b=>createHash('sha1').update(Buffer.from('blob '+b.length+'\0')).update(b).digest('hex');
const descriptor=p=>{const b=fs.readFileSync(p);return {path:path.relative(root,p).split(path.sep).join('/'),bytes:b.length,sha256:hash(b)}};
const wx=(p,b)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,b,{flag:'wx'});return descriptor(p)};
const require=createRequire(path.join(repo,'package.json'));
const prettier=require('prettier');
const sourcePaths=[
'src/context/theme-provider.tsx','src/context/theme-customization-provider.tsx','src/context/layout-provider.tsx','src/context/direction-provider.tsx','src/context/font-provider.tsx',
'src/lib/utils.ts','src/lib/cookies.ts','src/hooks/use-mobile.tsx',
'src/components/ui/sidebar.tsx','src/components/ui/button.tsx','src/components/ui/card.tsx','src/components/ui/dialog.tsx',
'src/components/layout/components/app-sidebar.tsx','src/components/layout/components/nav-group.tsx','src/styles/theme-presets.css','package.json'];
const legalPaths=['LICENSE','NOTICE','THIRD-PARTY-LICENSES.md'];
const requested=[...sourcePaths.map(p=>'web/'+p),...legalPaths];
const getLocal=p=>fs.readFileSync(path.join(repo,p));
const localPaths=sourcePaths.map(p=>'packages/web/'+p).concat(['LICENSE','NOTICE.frontend']);
const initialLocal=new Map(localPaths.map(p=>[p,getLocal(p)]));
const gitHead=spawnSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8',windowsHide:true});assert.equal(gitHead.status,0);
const initialHead=gitHead.stdout.trim();
const commands=[];
async function api(label,endpoint){
 const began=new Date().toISOString();const args=['api',endpoint];
 const process=spawn('gh',args,{cwd:repo,windowsHide:true,stdio:['ignore','pipe','pipe']});
 const out=[],err=[];process.stdout.on('data',d=>out.push(d));process.stderr.on('data',d=>err.push(d));
 const outcome=await new Promise(resolve=>{let error=null;process.on('error',e=>error={name:e.name,message:e.message,code:e.code});process.on('close',(code,signal)=>resolve({code,signal,error}));});
 const stdout=Buffer.concat(out),stderr=Buffer.concat(err);
 const stdoutPath=path.join(root,'api',label+'.stdout.json'),stderrPath=path.join(root,'api',label+'.stderr.txt');
 const stdoutRecord=wx(stdoutPath,stdout),stderrRecord=wx(stderrPath,stderr);
 const receipt={closed:true,actualExitCode:outcome.code,signal:outcome.signal,spawnError:outcome.error,program:'gh',arguments:args,startedAt:began,completedAt:new Date().toISOString(),stdout:stdoutPath,stderr:stderrPath,stdoutBytes:stdout.length,stderrBytes:stderr.length};
 const receiptRecord=wx(path.join(root,'api',label+'.result.json'),JSON.stringify(receipt,null,2)+'\n');commands.push({label,...receipt,stdoutRecord,stderrRecord,receiptRecord});
 assert.equal(outcome.code,0,label+' API request failed');assert.equal(outcome.signal,null);assert.equal(outcome.error,null);
 return JSON.parse(stdout.toString('utf8'));
}
for(const label of ['repository','candidate-commit','candidate-tree']){const r=JSON.parse(fs.readFileSync(path.join(root,'api',label+'.result.json')));commands.push({label,...r,reusedImmutableOriginalReceipt:true});}
const repository=JSON.parse(fs.readFileSync(path.join(root,'api','repository.stdout.json')));
assert.equal(repository.full_name.toLowerCase(),upstream.toLowerCase());assert.equal(repository.private,false);
const commit=JSON.parse(fs.readFileSync(path.join(root,'api','candidate-commit.stdout.json')));
assert.match(commit.sha,/^[a-f0-9]{40}$/);const candidate=commit.sha;
const tree=await api('candidate-tree-v2-exact-root-tree','repos/'+upstream+'/git/trees/'+commit.commit.tree.sha+'?recursive=1');
assert.equal(tree.truncated,false);assert.equal(tree.sha,commit.commit.tree.sha);
const treeIndex=new Map(tree.tree.map(x=>[x.path,x]));
const fetched=new Map();
let next=0;
await Promise.all(Array.from({length:4},async()=>{while(next<requested.length){const index=next++;const p=requested[index];const item=treeIndex.get(p);if(!item){fetched.set(p,{missing:true});continue;}assert.equal(item.type,'blob');const object=await api('blob-'+String(index+1).padStart(2,'0'),'repos/'+upstream+'/git/blobs/'+item.sha);assert.equal(object.sha,item.sha);assert.equal(object.encoding,'base64');const bytes=Buffer.from(object.content,'base64');assert.equal(bytes.length,object.size);assert.equal(blob(bytes),item.sha);const stored=wx(path.join(root,'upstream-raw',p),bytes);fetched.set(p,{bytes,stored,blobSha:item.sha,size:item.size,url:'https://github.com/'+upstream+'/blob/'+candidate+'/'+p});}}));
const batched=spawnSync('git',['cat-file','--batch'],{cwd:repo,input:localPaths.map(p=>firstTracked+':'+p+'\n').join(''),maxBuffer:64*1024*1024,windowsHide:true});assert.equal(batched.status,0);assert.equal(batched.stderr.length,0);
const first=new Map();let offset=0;
for(const p of localPaths){const end=batched.stdout.indexOf(10,offset);assert.ok(end>=offset);const header=batched.stdout.subarray(offset,end).toString();if(header.endsWith(' missing')){first.set(p,{missing:true});offset=end+1;continue;}const [id,type,length]=header.split(' ');assert.equal(type,'blob');const bytes=batched.stdout.subarray(end+1,end+1+Number(length));assert.equal(blob(bytes),id);assert.equal(batched.stdout[end+1+Number(length)],10);first.set(p,{bytes,blobSha:id,stored:wx(path.join(root,'first-tracked-raw',p),bytes)});offset=end+1+Number(length)+1;}
assert.equal(offset,batched.stdout.length);
const copyrightStart=/^\s*\/\*[\s\S]*?\*\//;
function stages(bytes){const text=new TextDecoder('utf8',{fatal:true}).decode(bytes);const lf=text.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');const leading=lf.match(copyrightStart)?.[0];const strip=leading&&/copyright/i.test(leading)&&/license|general public/i.test(leading)?lf.slice(leading.length).replace(/^\n+/,''):lf;return {lf,strip,removedLeadingCopyright:leading&&strip!==lf?{bytes:Buffer.byteLength(leading),sha256:hash(Buffer.from(leading))}:null};}
async function format(bytes,p){const normalized=stages(bytes);const parser=p.endsWith('.css')?'css':p.endsWith('.json')?'json':'typescript';try {const formatted=await prettier.format(normalized.strip,{parser,semi:false,singleQuote:true,tabWidth:2,useTabs:false,trailingComma:'all',quoteProps:'as-needed',endOfLine:'lf'});return {...normalized,formatted,parser,formatError:null};}catch(error){return {...normalized,formatted:null,parser,formatError:{name:error.name,message:error.message}};}}
const comparisons=[];
for(const p of sourcePaths){const localPath='packages/web/'+p,remotePath='web/'+p;const current=initialLocal.get(localPath),old=first.get(localPath),remote=fetched.get(remotePath);const currentStored=wx(path.join(root,'current-raw',localPath),current);if(remote.missing){comparisons.push({localPath,upstreamPath:remotePath,candidatePathAbsent:true,current:{...currentStored,gitBlobSha:blob(current)},firstTracked:old.missing?{missing:true}:{...old.stored,gitBlobSha:old.blobSha},rawMatch:false});continue;}
 const a=await format(current,p),b=await format(remote.bytes,p),c=old.missing?null:await format(old.bytes,p);
 const writeNorm=(side,n)=>n.formatted==null?null:wx(path.join(root,'normalized',side,p),n.formatted);
 const currentNorm=writeNorm('current',a),remoteNorm=writeNorm('upstream',b),firstNorm=c?writeNorm('first-tracked',c):null;
 comparisons.push({localPath,upstreamPath:remotePath,candidateUrl:remote.url,current:{...currentStored,gitBlobSha:blob(current)},upstream:{...remote.stored,gitBlobSha:remote.blobSha},firstTracked:old.missing?{missing:true}:{...old.stored,gitBlobSha:old.blobSha},currentVsCandidate:{rawBytesEqual:current.equals(remote.bytes),bomLfOnlyEqual:a.lf===b.lf,leadingCopyrightLfEqual:a.strip===b.strip,leadingCopyrightPrettierEqual:a.formatted!=null&&b.formatted!=null&&a.formatted===b.formatted},firstTrackedVsCandidate:old.missing?null:{rawBytesEqual:old.bytes.equals(remote.bytes),bomLfOnlyEqual:c.lf===b.lf,leadingCopyrightLfEqual:c.strip===b.strip,leadingCopyrightPrettierEqual:c.formatted!=null&&b.formatted!=null&&c.formatted===b.formatted},normalizedRecords:{current:currentNorm,upstream:remoteNorm,firstTracked:firstNorm},normalizationHeaders:{current:a.removedLeadingCopyright,upstream:b.removedLeadingCopyright,firstTracked:c?.removedLeadingCopyright??null},formatErrors:{current:a.formatError,upstream:b.formatError,firstTracked:c?.formatError??null}});
}
const legal=[];
for(const p of legalPaths){const remote=fetched.get(p);assert.ok(remote&&!remote.missing);const localPath=p==='NOTICE'?'NOTICE.frontend':p;const local=initialLocal.get(localPath);const localStored=local?wx(path.join(root,'current-raw',localPath),local):null;const currentText=local?.toString('utf8').replace(/\r\n/g,'\n'),remoteText=remote.bytes.toString('utf8').replace(/\r\n/g,'\n');legal.push({upstreamPath:p,candidateUrl:remote.url,upstream:{...remote.stored,gitBlobSha:remote.blobSha},localPath:local?localPath:null,local:localStored,rawBytesEqual:local?local.equals(remote.bytes):null,lfOnlyEqual:local?currentText===remoteText:null,localHasCompleteUpstreamNoticeAsPrefix:p==='NOTICE'?currentText.startsWith(remoteText.trimEnd()):null,contentType:'source-project-license-or-notice-evidence-no-legal-conclusion'});}
for(const [p,b]of initialLocal){assert.ok(getLocal(p).equals(b),'Local source changed during upstream audit: '+p);}
const report={schema:'cinatoken.web.upstream-candidate-bounded-evidence.v1',observedAt:new Date().toISOString(),status:'BOUNDED_CANDIDATE_MAPPING_ONLY',localHeadAtStart:initialHead,firstTrackedCommit:firstTracked,physicalImportDate:null,actualImportRef:null,actualImportCommit:null,sourceRequirementComplete:false,originalUnknownMapping:{total:579,corresponding:253,unknown:326,unchanged:true,notReclassifiedByThisAudit:true},officialRepository:{fullName:repository.full_name,url:repository.html_url,defaultBranch:repository.default_branch},candidate:{sha:candidate,treeSha:tree.sha,refSelection:'Observed default-branch HEAD used solely as one bounded comparison candidate; not inferred imported ref/date',authorDate:commit.commit.author.date,committerDate:commit.commit.committer.date,url:commit.html_url,parents:commit.parents.map(x=>x.sha)},comparisons,legal,normalization:{rawIdentity:'original bytes and verified Git blob SHA1 before normalization',stages:['BOM removed and CRLF/loneCR mapped to LF','only first leading block comment removed when it declares copyright plus license/general public','Prettier with one pinned local version/options to compare formatting-normalized text'],prettierVersion:prettier.version,prettierOptions:{semi:false,singleQuote:true,tabWidth:2,useTabs:false,trailingComma:'all',quoteProps:'as-needed',endOfLine:'lf'},normalizedMatchesAreNotRawMatches:true,noLicenseComplianceOrOwnershipInferred:true},counts:{requestedUpstreamPaths:requested.length,codeComparisons:comparisons.length,legalDocuments:legal.length,currentRawMatches:comparisons.filter(x=>x.currentVsCandidate?.rawBytesEqual).length,currentCopyrightAndFormattingMatches:comparisons.filter(x=>x.currentVsCandidate?.leadingCopyrightPrettierEqual).length,firstTrackedRawMatches:comparisons.filter(x=>x.firstTrackedVsCandidate?.rawBytesEqual).length,firstTrackedCopyrightAndFormattingMatches:comparisons.filter(x=>x.firstTrackedVsCandidate?.leadingCopyrightPrettierEqual).length,missingUpstreamPaths:comparisons.filter(x=>x.candidatePathAbsent).length},commands,sourceInputs:[{repositoryPath:'NOTICE.frontend',...descriptor(path.join(root,'current-raw','NOTICE.frontend'))},{repositoryPath:'scripts/web/source-provenance.mjs',originalBytes:fs.statSync(path.join(repo,'scripts/web/source-provenance.mjs')).size,originalSha256:hash(fs.readFileSync(path.join(repo,'scripts/web/source-provenance.mjs')))}],scope:{repositoryWrites:0,oldEvidenceWrites:0,commits:0,prs:0,productTests:0,productionRequests:0,upstreamCandidates:1,unboundedHistorySearch:false},limitations:['A code-byte or normalized match proves equality at this candidate only; it does not identify the actual import commit, physical date, original author or full reuse boundary.','Current or first-tracked source that differs from this one candidate is unresolved, not proof of independent ownership or another source.','Upstream legal files are retained as source evidence; no legal/compliance determination is made.','Historical 579/253/326 mapping and prior unresolved provenance remain unchanged.']};
const reportPath=path.join(root,'FINAL-upstream-candidate-provenance.json');wx(reportPath,JSON.stringify(report,null,2)+'\n');
const manifest={schema:'cinatoken.web.upstream-candidate-sealed-files.v1',files:[]};
function enumerate(dir){for(const ent of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const p=path.join(dir,ent.name);if(ent.isDirectory())enumerate(p);else if(ent.isFile())manifest.files.push(descriptor(p));else throw new Error('Non regular evidence');}}
enumerate(root);wx(path.join(root,'sealed-files.json'),JSON.stringify(manifest,null,2)+'\n');console.log(JSON.stringify({report:descriptor(reportPath),root,candidate,counts:report.counts,matched:comparisons.filter(x=>x.currentVsCandidate?.leadingCopyrightPrettierEqual).map(x=>x.localPath),unresolved:comparisons.filter(x=>!x.currentVsCandidate?.leadingCopyrightPrettierEqual).map(x=>x.localPath),legal}));