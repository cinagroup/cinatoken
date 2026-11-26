import assert from 'node:assert/strict';
import test from 'node:test';
import {POST} from './route';

test('CinaToken password endpoint stays disabled without reading credentials or an unbounded body',async()=>{
 let read=false;
 const body=new ReadableStream<Uint8Array>({pull(){read=true;}} ,{highWaterMark:0});
 const response=await POST(new Request('https://token.example.invalid/api/auth/login',{method:'POST',headers:{Origin:'https://token.example.invalid'},body,duplex:'half'} as RequestInit));
 assert.equal(response.status,410);
 assert.equal(response.headers.get('Cache-Control'),'no-store');
 const payload = await response.json() as {message: string};
 assert.match(payload.message,/CinaAuth/);
 assert.equal(read,false);
 await body.cancel();
});
test('password endpoint retains the exact browser-origin check',async()=>{
 for(const origin of [undefined,'https://different.example.invalid']) {
  const headers=new Headers();if(origin)headers.set('Origin',origin);
  const response=await POST(new Request('https://token.example.invalid/api/auth/login',{method:'POST',headers}));
  assert.equal(response.status,403);
  assert.equal(response.headers.get('Cache-Control'),'no-store');
 }
});
