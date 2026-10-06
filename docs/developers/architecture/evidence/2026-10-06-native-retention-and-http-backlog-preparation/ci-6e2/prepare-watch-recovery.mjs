import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {out} from './capture.mjs';
const source=await readFile(join(out,'watch-proxy.mjs'),'utf8'),needle="const label='proxy-watch-1'";
assert.equal(source.split(needle).length-1,1);
await writeFile(join(out,'watch-proxy-2.mjs'),source.replace(needle,"const label='proxy-watch-2'"),{flag:'wx'});
console.log(JSON.stringify({sameRun:37424911830,intervalSeconds:45,previousWatchRetained:true,nextWatchLabel:'proxy-watch-2',ciActions:0}));
