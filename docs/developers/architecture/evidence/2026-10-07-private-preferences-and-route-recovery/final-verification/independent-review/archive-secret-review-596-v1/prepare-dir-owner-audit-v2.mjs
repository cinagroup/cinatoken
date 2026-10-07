import {readFileSync,writeFileSync} from 'node:fs'
import {resolve,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
const own=dirname(fileURLToPath(import.meta.url)),source=readFileSync(resolve(own,'audit-all-dir-owner-bindings-v1.mjs'),'utf8')
writeFileSync(resolve(own,'audit-all-dir-owner-bindings-v2.mjs'),source.replace('recipe:frozenProof(recipePath)','recipe:proof(recipePath)').replace('all22-dir-owner-output-bindings-v1.json','all22-dir-owner-output-bindings-v2.json'),{flag:'wx'})
console.log('Immutable v2 changes only final report recipe proof capture: READY is the enclosing manifest produced after its frozen child inventory and cannot select itself; all22 owner checks unchanged. Original actual1 final-record failure preserved.')
