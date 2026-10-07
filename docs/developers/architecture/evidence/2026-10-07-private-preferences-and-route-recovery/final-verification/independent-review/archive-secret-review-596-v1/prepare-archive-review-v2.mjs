import {readFileSync,writeFileSync} from 'node:fs'
import {resolve,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
const root=dirname(fileURLToPath(import.meta.url)),source=readFileSync(resolve(root,'review-archive-schema-v6.mjs'),'utf8')
writeFileSync(resolve(root,'review-archive-schema-v6-v2.mjs'),source.replaceAll('originalReceipt.stderr.','originalReceipt.streams.stderr.').replace('archive-schema-v6-readonly-review.json','archive-schema-v6-readonly-review-v2.json'),{flag:'wx'})
console.log('Prepared immutable review v2: original archive v5 receipt actually nests stream bindings under streams; original review actual1 remains preserved.')
