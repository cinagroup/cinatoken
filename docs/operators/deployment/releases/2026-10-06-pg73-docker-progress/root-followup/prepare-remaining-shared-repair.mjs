import fs from 'node:fs';import assert from 'node:assert/strict';
const temp="C:/Users/cina/AppData/Local/Temp/cinatoken-pg73-platform-followup-20261006-lAiHQC";let source=fs.readFileSync(temp+'/repair-next-shared-fixtures.mjs','utf8');
const start=source.indexOf('const specs=['),end=source.indexOf('\nconst records=',start);assert.ok(start>=0&&end>start);
const names=['postgres-shared-key-snapshot-earning-consumer.native.test.mjs','postgres-shared-key-economic-delivery.native.test.mjs','postgres-shared-key-credited-usage-gap.native.test.mjs','postgres-shared-key-credited-usage-store.native.test.mjs'];
const specs=names.map(name=>({name,variable:'files',loader:"const files=(await readdir(migrations)).filter(name=>name.endsWith('.sql')).sort();",grants:0}));
source=source.slice(0,start)+'const specs='+JSON.stringify(specs,null,2)+';'+source.slice(end);source=source.replace("'/next-shared-fixture-repair.json'","'/remaining-shared-fixture-repair.json'");fs.writeFileSync(temp+'/repair-remaining-shared-fixtures.mjs',source,{flag:'wx'});
