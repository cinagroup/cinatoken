import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
const validName=n=>typeof n==='string'&&n.length>0&&n.length<=256&&/^[A-Za-z0-9_./-]+$/.test(n)&&n.split('/').every(s=>s&&s!=='.'&&s!=='..');

/** Decode bounded Cloudflare script downloads without converting form fields to
 * strings. Downloaded code is untrusted data, never imported or executed. The
 * API uses name-only multipart fields as well as filename-bearing file parts.
 * Exact bytes, every module, framing and entrypoint must all be accounted for.
 */
export function parseByokWorkerContent({data,type,entrypoint}){
  try{
    assert.ok(data instanceof Uint8Array&&data.byteLength>0&&data.byteLength<=12582912);
    assert.ok(typeof type==='string'&&type.length<=256);const body=Buffer.from(data),modules=[],seen=new Set();
    const add=(name,bytes)=>{assert.ok(validName(name)&&!seen.has(name)&&modules.length<32);seen.add(name);
      const content=Buffer.from(bytes);modules.push({name,bytes:content,sha256:sha(content)});};
    if(/^(?:application\/javascript(?:\+module)?|text\/javascript)(?:;\s*charset=utf-8)?$/i.test(type)){
      entrypoint??='index.js';add(entrypoint,body);
    }else{
      const match=/^multipart\/form-data;\s*boundary=(?:"([A-Za-z0-9'()+_,./:=?-]{1,70})"|([A-Za-z0-9'()+_,./:=?-]{1,70}))$/i.exec(type);
      assert.ok(match);const boundary=match[1]??match[2],first=Buffer.from('--'+boundary+'\r\n'),marker=Buffer.from('\r\n--'+boundary);
      assert.ok(body.subarray(0,first.length).equals(first));let offset=first.length,closed=false;
      while(!closed){
        const end=body.indexOf('\r\n\r\n',offset);assert.ok(end>=offset&&end-offset<=4096);
        const headerBytes=body.subarray(offset,end);assert.ok(headerBytes.every(c=>c===13||c===10||c>=32&&c<=126));
        const headers=new Map();for(const line of headerBytes.toString('ascii').split('\r\n')){
          assert.ok(line.length<=1024);const split=line.indexOf(':');assert.ok(split>0);const key=line.slice(0,split).toLowerCase();
          assert.ok(['content-disposition','content-type'].includes(key)&&!headers.has(key));headers.set(key,line.slice(split+1).trim());
        }
        const disposition=/^form-data;\s*name="([A-Za-z0-9_./-]{1,256})"(?:;\s*filename="([A-Za-z0-9_./-]{1,256})")?$/.exec(headers.get('content-disposition')??'');
        assert.ok(disposition);if(disposition[2])assert.ok(validName(disposition[2]));
        const start=end+4;let next=body.indexOf(marker,start);
        while(next>=0){const suffix=body.subarray(next+marker.length,next+marker.length+2).toString('ascii');
          if(suffix==='\r\n'||suffix==='--')break;next=body.indexOf(marker,next+1);}
        assert.ok(next>=start);add(disposition[1],body.subarray(start,next));offset=next+marker.length;
        if(body.subarray(offset,offset+2).toString('ascii')==='--'){
          offset+=2;if(body.subarray(offset,offset+2).toString('ascii')==='\r\n')offset+=2;
          assert.equal(offset,body.length);closed=true;
        }else offset+=2;
      }
      assert.ok(closed);assert.ok(validName(entrypoint)&&seen.has(entrypoint));
    }
    assert.ok(validName(entrypoint)&&modules.length>0);return {entrypoint,modules};
  }catch{throw Error('byok_worker_content_invalid');}
}
