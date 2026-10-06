import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const [parentPeerRoot,parentPeerFinal,parentPeerSha,parentPeerBytes]=process.argv.slice(2);
assert(parentPeerRoot&&parentPeerFinal&&/^[a-f0-9]{64}$/.test(parentPeerSha));
const ci='C:/Users/cina/AppData/Local/Temp/cinatoken-d537-ci-terminal-observer-14da29e39da54262917a3e2d0d5ed3c8';
const localPeer='C:/Users/cina/AppData/Local/Temp/cinatoken-quote-packet-readonly-peer-XW05FR';
const signal='C:/Users/cina/AppData/Local/Temp/cinatoken-v364-request-signal-readonly-yCKd6V';
const six='C:/Users/cina/AppData/Local/Temp/cinatoken-remaining-six-native-minimal-inventory-354b4a0c896f91a10fd126f8';
const owner='C:/Users/cina/AppData/Local/Temp/cinatoken-legacy-parent-client-binding-repair-c3e097398c054113961be652993e62b0';
const pin=(dir,name,bytes,sha256)=>({path:path.join(dir,name),bytes,sha256});
const configPath=path.join(root,'terminal-collection-config.json');
const rootFiles=fs.readdirSync(root).filter(n=>/\.(?:mjs|json|log)$/.test(n)&&!['terminal-collection-config.json','terminal-collection-summary.json','terminal-checklist-proof.json'].includes(n)).map(n=>path.join(root,n));
rootFiles.push(configPath);
const config={relativeOut:'docs/developers/architecture/evidence/2026-10-06-native-quote-terminal-and-parent-binding',roots:[{label:'ci',path:ci},{label:'preparation-packet-peer',path:localPeer},{label:'signal-readonly',path:signal},{label:'remaining-six-readonly',path:six},{label:'parent-owner',path:owner},{label:'parent-peer',path:parentPeerRoot}],rootFiles,requiredPins:[
pin(ci,'FINAL-ci-terminal-observer.json',288169,'9d273f6d48c0d45bd4bca062896c7310fdc94f363e6d8dafdec85bd1e626ed53'),
pin(ci,'TERMINAL-STOPWRITE-SEAL.json',35325,'6727d6330b27d5319676cb06461ab23f9860b6260bf694278ed26cc52ba0465a'),
pin(ci,'native-terminal.stdout.log',667343,'29f68229763fc5c214ff07c380e91905ad1c70cfe4c00e674e3621fed338ba49'),
pin(ci,'dispatch-terminal-retry.stdout.log',5159606,'d1a431e6f7bafbddce2045e949a771cc5d4783f4cccad8dac690c95e0ef627f7'),
pin(localPeer,'FINAL-quote-packet-readonly-independent-peer.json',84120,'07607a26183e2d9be186b6843a19fb4ab7c47bc6ff923083785ccbd86ad00c3b'),
pin(localPeer,'STOPWRITE-peer-seal.json',1993,'86c885e5d0fc304fa5ff466885808c1ffeaa13dec79fcfc09698413bb288cb48'),
pin(signal,'FINAL-v364-request-signal-readonly-diagnosis.json',32661,'961fbddd0dfdc849c8630cc4d528b1a992e308b0f0daa0c4db4a58521062420e'),
pin(signal,'STOPWRITE.json',21010,'2acbfd1a8d3345c6ad0f7dfaa546ac55a2d5c5836dc61a58a0fd51f044b3b7ea'),
pin(six,'FINAL-remaining-six-native-gh-authoritative-inventory.json',35634,'e68490b7750dc7f7ab60281e2f0178186cf356324f9ca14bfa9e24adf79ff5a8'),
pin(owner,'FINAL-legacy-parent-client-binding-repair.json',7013,'b80fa3540b6cd4f25e75facedff761bcb56ea83519a0cddfe5a3209c5d97043a'),
pin(owner,'STOPWRITE.json',9618,'190413ce95c40289fbf0708d5da90f974e65b4a18a534607db37e27a16d977bf'),
pin(parentPeerRoot,parentPeerFinal,Number(parentPeerBytes),parentPeerSha),
pin('C:/cinagroup/cinatoken','scripts/db/cutover/postgres-legacy-parent-activation.native.test.mjs',30210,'7acb429e3c22ce959daa9e925f7d460ea30902eb077f09f39caa949cc8220f7a'),
pin('C:/cinagroup/cinatoken','scripts/db/cutover/postgres-shared-key-quote-versions.native.test.mjs',34873,'c72cc41a679c64a1fb7edd733fe450e3cea8a9bdc9408b8cb152fb0a9135187f')
],readme:'# d537 原 Linux 终态与第110步客户端绑定准备\n\n[来源/存储索引](collection.json)、[本SHA原CI终态](ci/FINAL-ci-terminal-observer.json)、[真实关闭seal](ci/TERMINAL-STOPWRITE-SEAL.json)、[完整native日志](ci/native-terminal.stdout.log.gz)、[完整dispatch日志](ci/dispatch-terminal-retry.stdout.log.gz)、[第110步准备](parent-owner/FINAL-legacy-parent-client-binding-repair.json)、[独立源审](parent-peer/'+parentPeerFinal+')、[准备证据整包独立复核](preparation-packet-peer/FINAL-quote-packet-readonly-independent-peer.json)、[下一取消只读诊断](signal-readonly/FINAL-v364-request-signal-readonly-diagnosis.json)、[剩六库存](remaining-six-readonly/FINAL-remaining-six-native-gh-authoritative-inventory.json)、[下一诊断方案](root/next-http-cancel-diagnosis-plan.md)。\n\n106步102成功/1失败/3跳过；26目标、剩6、94/109及报价24实际通过。native110 ReferenceError及strict8/7/1仍失败，所有原失败/raw保留，完整日志gzip解码bytes/SHA严格相同。第110步仅准备三处migrator:sql，待下一提交原Linux；收集0不代替业务或原生门槛。Root文件为本轮显式直接子集，不重复旧3357/208归档或CI派生切片，checklist原4a9 before直接由原Git快照可取。生产仍c13/2a0/100%。\n'};
rootFiles.push(path.join(root,'next-http-cancel-diagnosis-plan.md'));
assert.equal(new Set(rootFiles).size,rootFiles.length);
fs.writeFileSync(configPath,JSON.stringify(config,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({configPath,roots:config.roots.length,rootFiles:rootFiles.length,pins:config.requiredPins.length}));
