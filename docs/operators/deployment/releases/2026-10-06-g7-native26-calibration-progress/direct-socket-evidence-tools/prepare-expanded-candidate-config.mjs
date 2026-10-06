import fs from 'node:fs';import path from 'node:path';
const root=path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u,'$1'));
const config=JSON.parse(fs.readFileSync(path.join(root,'prepared-frozen-roots-config.json'),'utf8'));
for(const [id,directory,phase]of [
 ['native59-inventory','cinatoken-native59-full-inventory-10b2722ab06d4cf6b6305e24571b4a8d','source-peer-review'],
 ['v364-next-diagnosis','cinatoken-v364-next-readonly-20261006-d951a0fe223e4a3aacb8d9e13ea5946b','source-peer-review'],
 ['previous-durable-meta','cinatoken-native-g7-durable-meta-4d1a6190eb7e440fb1bce29961eaaea7','historical-and-current'],
])config.roots.push({id,path:'C:/Users/cina/AppData/Local/Temp/'+directory,phase});
config.sourceCommitAdmission='Exact Root-reported dcc6 commit; prepare/read only. Current Linux results and exact final artifact source binding remain Root responsibility after terminal closure.';
Object.assign(config.semantics,{rootReportedFrozenAdditionalRoots:3,currentGrowingRootNotWalked:true,collectorMetadataRootNotIncluded:true});
fs.writeFileSync(path.join(root,'prepared-expanded-frozen-roots-config.json'),JSON.stringify(config,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({frozenRootCandidates:config.roots.length,currentGrowthAndCollectorMetadataNotIncluded:true,productionRequests:0}));
