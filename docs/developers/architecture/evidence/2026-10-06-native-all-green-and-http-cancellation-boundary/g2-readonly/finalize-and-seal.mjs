import {readFileSync,writeFileSync,readdirSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const root=process.argv[2];
const sha=b=>createHash('sha256').update(b).digest('hex');
const desc=path=>{const b=readFileSync(join(root,path));return {path,bytes:b.length,sha256:sha(b)};};
const analysis=JSON.parse(readFileSync(join(root,'next-real-acceptance-analysis.json'),'utf8'));
const receipt=JSON.parse(readFileSync(join(root,'readonly-source.closed.json'),'utf8'));
if(receipt.actualExit!==0||receipt.signal!==null||receipt.spawnError!==null)throw Error('Original readonly reader did not close successfully');
for(const [kind,path] of [['stdout','readonly-source.stdout.log'],['stderr','readonly-source.stderr.log']]){
 const d=desc(path);if(d.bytes!==receipt[kind].bytes||d.sha256!==receipt[kind].sha256)throw Error('Raw binding mismatch');
}
const final={
 ...analysis,
 schema:'cinatoken-next-real-acceptance-readonly-FINAL-v1',
 finalizedAt:new Date().toISOString(),
 facts:analysis.facts.map(x=>x.id==='smallest-real-business-gate'?{...x,line:385}:x),
 reportLocationCorrection:{originalAnalysisLine:387,correctP2_12Line:385,originalAnalysisPreserved:true,scope:'Location annotation only; same checklist text and conclusion.'},
 actualReadAuthority:receipt,
 originalAnalysis:desc('next-real-acceptance-analysis.json'),
 receiptSummary:{trueCapturedSourceReaderChildren:1,actualZero:1,actualNonzero:0,
 priorCombinedToolObservations:[{path:'reader-failed-tool-observation.json',reportedExitCode:1,reason:'PowerShell ParserError before body execution'}],
 noBootstrapOrFSReadCountedAsPGOrBusinessPass:true},
 readyToExecuteNow:false,
 readyMeaning:'Commands are identified and can be prepared on an authorized configured staging host. Current local process has none of the 15 required input variables; 5 operator-private env paths checked are absent. No source or deployment secret inventories were read, so production/external configuration remains unknown.',
 recommendedImmediateAction:'After the original native result is known, resolve the private staging configuration/actual CinaAuth client and real subject/workspace inputs, connect runtime under its intended ACL, and implement/run the first genuine P2-12 G2 Key lifecycle slice. Existing stage0 workflow is insufficient.',
 STOPWRITE:true
};
writeFileSync(join(root,'FINAL-next-real-acceptance-readonly.json'),JSON.stringify(final,null,2)+'\n',{flag:'wx'});
const files=readdirSync(root).filter(x=>x!=='STOPWRITE.json').sort().map(path=>{if(!statSync(join(root,path)).isFile())throw Error('Unexpected owned directory');return desc(path);});
const seal={schema:'owned-root-STOPWRITE-seal-v1',frozenAt:new Date().toISOString(),root,
 coverage:'All owned ordinary files except this self-describing seal',completeFileCountExcludingSeal:files.length,files,
 readOnlySourceReviewActualExit:receipt.actualExit,
 preliminaryToolReportedFailurePreserved:true,
 newNativeOrBusinessRun:false,productionRequests:0,secretsDisclosed:false,
 repositoryModified:false,fullG7Verified:false,fullG8Verified:false,STOPWRITE:true};
writeFileSync(join(root,'STOPWRITE.json'),JSON.stringify(seal,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({root,FINAL:desc('FINAL-next-real-acceptance-readonly.json'),seal:desc('STOPWRITE.json'),completeOwnedFiles:files.length+1,STOPWRITE:true}));

