import assert from 'node:assert/strict';

/** Local WebSocketPair/101 adapter only. Not a Workers runtime emulator or
 * evidence of native abort/host lifecycle. No network, no shared business I/O. */
export function installPeerV3TestRuntime(t){
  const pairs=[],original=Object.getOwnPropertyDescriptor(globalThis,'WebSocketPair');
  class Socket extends EventTarget{
    messages=[];closed=false;accepted=false;failSend=false;closeCalls=[];
    accept(){this.accepted=true;}
    send(text){if(this.failSend||this.closed)throw Error('local-secret');this.messages.push(text);}
    close(code,reason){this.closeCalls.push({code,reason});if(!this.closed){this.closed=true;this.dispatchEvent(new Event('close'));}}
    incoming(data){const event=new Event('message');Object.defineProperty(event,'data',{value:data});this.dispatchEvent(event);}
    read(){return this.messages.splice(0).map(text=>JSON.parse(text));}
  }
  Object.defineProperty(globalThis,'WebSocketPair',{configurable:true,writable:true,value:class{
    constructor(){this[0]=new Socket();this[1]=new Socket();pairs.push(this);}
  }});
  t.after(()=>{for(const p of pairs)p[1].close(1000,'test_teardown');if(original)Object.defineProperty(globalThis,'WebSocketPair',original);else delete globalThis.WebSocketPair;});
  const Native=globalThis.Response;
  class UpgradeResponse extends Native{
    constructor(body,init){super(body,init?.status===101?{...init,status:200}:init);
      if(init?.status===101){Object.defineProperty(this,'status',{value:101});Object.defineProperty(this,'webSocket',{value:init.webSocket});}
    }
  }
  t.mock.method(globalThis,'Response',UpgradeResponse);
  t.mock.method(globalThis,'fetch',()=>assert.fail('No external network'));
  return {pairs};
}
