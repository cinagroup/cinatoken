import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
const originalPins=JSON.parse(fs.readFileSync(new URL('./native59-original-receipt-pins.json',import.meta.url),'utf8'));
export const native59BindingDialect='native59-exact-info-only-output-binding-v1';
export function validateNative59InfoBinding({contextRoot,receiptName,item,value,binding,data}){
  assert.equal(path.resolve(contextRoot).toLowerCase(),path.resolve(originalPins.root).toLowerCase(),'Native59 original frozen root only');
  const original=originalPins.receipts.find(receipt=>receipt.file===receiptName);assert.ok(original,'Only the two exact original Info-only receipts admitted');
  assert.equal(binding.dialect,native59BindingDialect);assert.equal(binding.expectedReceiptSha256,original.sha256);assert.equal(item.sha256,original.sha256);
  assert.equal(item.bytes.length,original.bytes);assert.deepEqual(JSON.parse(item.bytes),value,'Original decoded receipt must match pinned bytes');
  assert.equal(value.executable,'git');assert.deepEqual(value.args,original.args);
  assert.ok(Number.isSafeInteger(value.actualExit)&&value.actualExit>=0);assert.equal(value.signal,null);assert.equal(value.spawnError,undefined);
  assert.ok(typeof value.at==='string'&&typeof value.finishedAt==='string'&&Number.isFinite(Date.parse(value.at))&&Number.isFinite(Date.parse(value.finishedAt))&&Date.parse(value.at)<=Date.parse(value.finishedAt));
  assert.equal(value.stdout,undefined);assert.equal(value.stderr,undefined);
  const expected=['stdout','stderr'].map(stream=>({file:receiptName.replace(/\.closed\.json$/u,'.'+stream+'.log'),bytes:value[stream+'Info']?.bytes,sha256:value[stream+'Info']?.sha256}));
  assert.deepEqual(binding.outputs,expected,'Bind exactly both original Info descriptors in original stream order');
  for(const descriptor of expected){assert.ok(Number.isSafeInteger(descriptor.bytes)&&descriptor.bytes>=0&&/^[0-9a-f]{64}$/u.test(descriptor.sha256));
    const output=data.get(descriptor.file);assert.ok(output,'Exact original raw stream must be included');
    assert.equal(output.bytes.length,descriptor.bytes);assert.equal(output.sha256,descriptor.sha256);
    assert.ok(output.mtimeMs<=item.mtimeMs,'Original output cannot be newer than original receipt');}
  return {receipt:{dialect:'native59-exact-pinned-info-command-v1',actualExit:value.actualExit,signal:null,spawnError:null,
    startedAt:value.at,finishedAt:value.finishedAt,actualOriginalInfoOnlyCommand:true,actualChildExitProven:true,
    originalReceiptPinnedSha256:original.sha256,independentNewExecutionClaimed:false,linuxRuntimeExecuted:false,gatePassDerived:false},outputs:expected};
}
