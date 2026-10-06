import fs from 'node:fs';
const root='C:/Users/cina/AppData/Local/Temp/cinatoken-g7-observe-dependency-fix-02e2061ea37b4d18af99a3675ec1b7fc';
let source=fs.readFileSync(root+'/audit-final-owner.mjs','utf8');
source=source.replace("filter(f=>f.endsWith('.result.json'))","filter(f=>f.endsWith('.result.json')&&/^(first|final)-/.test(f))");
source=source.replace("fs.writeFileSync(out+'/final-'+path.basename(p.relative),current,{flag:'wx'});","assert.equal(fs.readFileSync(out+'/final-'+path.basename(p.relative),'utf8'),current);");
source=source.replace("fs.writeFileSync(out+'/diff-'+path.basename(p.relative)+'.patch',createTwoFilesPatch(p.relative+' (702 baseline)',p.relative+' (candidate)',original,current),{flag:'wx'});","assert.equal(fs.readFileSync(out+'/diff-'+path.basename(p.relative)+'.patch','utf8'),createTwoFilesPatch(p.relative+' (702 baseline)',p.relative+' (candidate)',original,current));");
source=source.replace("const result={schema:","const priorReview={actualExit:1,toolChunk:'92646d',report:fingerprint(out+'/FINAL-g7-observe-dependency-owner-review.json'),negativePreserved:true,reason:'Reviewer glob matched original-Linux result copies in addition to eight owner results; fixed only Temp reader file selection, not original logs or source'};\nconst result={priorReview,schema:");
source=source.replace("const p=out+'/FINAL-g7-observe-dependency-owner-review.json'","const p=out+'/FINAL-g7-observe-dependency-owner-review-v2.json'");
fs.writeFileSync(root+'/audit-final-owner-v2.mjs',source,{flag:'wx'});