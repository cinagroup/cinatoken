import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readNativeMediaJson } from './native-media-request-context';
function context(request: Request) {
 const tasks: Promise<unknown>[] = [];
 return { tasks, c: {req:{raw:request},get:()=>undefined,executionCtx:{waitUntil:(task:Promise<unknown>)=>tasks.push(task)}} as unknown as Parameters<typeof readNativeMediaJson>[0] };
}
it('native JSON ingress confirms EOF through the host resource channel', async()=>{
 const f=context(new Request('https://gateway.test/native',{method:'POST',body:'{"model":"test","input":{"text":"hello"}}'}));
 assert.deepEqual(await readNativeMediaJson(f.c),{model:'test',input:{text:'hello'}});
 assert.equal(f.tasks.length,1);
 await Promise.all(f.tasks);
});
it('native JSON abort returns promptly while a stalled ingress cancellation remains owned', async()=>{
 const abort=new AbortController();
 let cancelled=false;
 const f=context(new Request('https://gateway.test/native',{method:'POST',signal:abort.signal,body:new ReadableStream({cancel(){cancelled=true;return new Promise(()=>{});}}),duplex:'half'} as RequestInit));
 const read=readNativeMediaJson(f.c);
 abort.abort();
 await assert.rejects(read);
 assert.equal(cancelled,true);
 assert.equal(f.tasks.length,1);
 let completed=false;
 void f.tasks[0]!.then(()=>{completed=true;});
 await Promise.resolve();
 assert.equal(completed,false);
});
