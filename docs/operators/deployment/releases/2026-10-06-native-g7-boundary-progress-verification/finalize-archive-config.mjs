import fs from 'node:fs';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const meta="C:/Users/cina/AppData/Local/Temp/cinatoken-native-g7-durable-meta-4d1a6190eb7e440fb1bce29961eaaea7",config=JSON.parse(fs.readFileSync(meta+'/archive-config-prepared.json','utf8')),sha=b=>createHash('sha256').update(b).digest('hex');
config.roots.push({id:'boundary-terminal-peer',path:'C:/Users/cina/AppData/Local/Temp/cinatoken-v364-boundary-terminal-readonly-dadfa5000d064bd08eeab54de4130cd8',phase:'source-peer-review'});
config.roots.push({id:'native-next-four-inventory',path:'C:/Users/cina/AppData/Local/Temp/cinatoken-native53-six-inventory-b5e488785b0d4b00a7f69724a8a418e4',phase:'prepared-only'});
if(process.argv[2]){assert.ok(fs.statSync(process.argv[2]).isDirectory());config.roots.push({id:'checklist-terminal-peer',path:process.argv[2],phase:'source-peer-review'});}
config.requiredRootIds=config.roots.map(r=>r.id);
const release=config.roots.find(r=>r.id==='release-preparation');
config.explicitByteCopyBindings=[{rootId:release.id,provenanceFile:'original-ci-failure-provenance.json',expectedProvenanceSha256:sha(fs.readFileSync(release.path+'/original-ci-failure-provenance.json'))}];
delete config.semantics.g7SecondRuntimePending;
delete config.semantics.fullScope.literalCheckboxes;
Object.assign(config.semantics,{g7SecondRuntimeActualExit:1,g7SecondWireActualExit:0,g7SecondSeedActualExit:0,g7SecondProxyObserveActualExit:0,g7SecondAdminObserveActualExit:1,g7SecondRuntimeChildren:165,g7SecondFallbackChildren:29,g7InitialRecursiveArtifactFiles:352,g7SecondRecursiveArtifactFiles:601,g7InitialTopLevelFiles:350,g7SecondTopLevelEntries:600,fullG7Verified:false,fullG8Verified:false,release07RunActualConclusion:'success',release07RunId:37403800144,releaseDraftHead:'117c3ba4d7c0d10c5ce8cfc264ba1d6548339812',releaseDraftOpen:true,releaseDraftStillDraft:true,mainVersionsPublished:false,nextNativeInventoryIsStaticNotExecution:true});
Object.assign(config.semantics.fullScope,{checkboxLines:213,checkboxTokens:214});
fs.writeFileSync(meta+'/archive-config-final.json',JSON.stringify(config,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({actualExit:0,roots:config.roots.length,dirExclusions:release.excludeDirectories.length,sourceCommit:config.sourceCommit,gatePassDerived:false}));

