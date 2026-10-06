import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const dir='C:/cinagroup/cinatoken/scripts/diagnostics/v364-direct-socket',p=dir+'/sealed-package.json';
const manifest=JSON.parse(fs.readFileSync(p,'utf8')),before=JSON.parse(fs.readFileSync('C:/Users/cina/AppData/Local/Temp/cinatoken-v364-direct-actual-review-DjepMs/source-before/scripts/diagnostics/v364-direct-socket/sealed-package.json','utf8'));
assert.deepEqual(manifest,before);const row=manifest.files.find(r=>r.path==='native-reader-calibration.mjs');assert.ok(row);const bytes=fs.readFileSync(dir+'/'+row.path);row.bytes=bytes.length;row.sha256=createHash('sha256').update(bytes).digest('hex');
fs.writeFileSync(p,JSON.stringify(manifest,null,2)+'\n');console.log(JSON.stringify({updatedOnlyOneHelperDescriptor:row,existingPreparedAtHeadMeansOriginalPackagePreparation:manifest.preparedAtHead,repairPreparedAtHead:'dcc6ab52f21a18c5d1c02d8a4a4a390f039e61fc'}));
