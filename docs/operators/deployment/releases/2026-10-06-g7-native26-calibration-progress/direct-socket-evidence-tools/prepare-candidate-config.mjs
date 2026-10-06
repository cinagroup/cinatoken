import fs from 'node:fs';import path from 'node:path';
const root=path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u,'$1'));
const old='C:/Users/cina/AppData/Local/Temp/cinatoken-native26-direct-socket-archive-inventory-97f10624f7a344a89187435b65641546';
const config=JSON.parse(fs.readFileSync(path.join(old,'future-subset-config-advisory.json'),'utf8'));
config.sourceCommit='dcc6ab52f21a18c5d1c02d8a4a4a390f039e61fc';
config.sourceCommitAdmission='Root reported pushed commit only; no new Git/CI queries, final runtime receipt SHA still to be verified separately';
config.releaseSlug='2026-10-06-native26-direct-socket-dialect-prepared-subset';
config.outputDirectory=path.join(root,'future-output-not-created');
config.roots.push({id:'archive-frozen-inventory',path:old,phase:'prepared-only'},
 {id:'direct-socket-dialect-peer',path:'C:/Users/cina/AppData/Local/Temp/cinatoken-direct-socket-archive-dialect-peer-readonly-5acafdc971304ac180e80be74277ec8f',phase:'source-peer-review'});
Object.assign(config.semantics,{sourcePreparationBase:'473de5fc520fc7d64db700db88a76c7a6b45c241',reportedPushedCommit:config.sourceCommit,
  currentLinuxResult:null,newToolRootIncluded:false,syntheticDialectControlsNotApplicationTests:true,originalAdmission1Preserved:true});
fs.writeFileSync(path.join(root,'prepared-frozen-roots-config.json'),JSON.stringify(config,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({candidateFrozenRoots:config.roots.length,sourceReportedByRoot:config.sourceCommit,linuxResultClaimed:false,productionRequests:0}));
