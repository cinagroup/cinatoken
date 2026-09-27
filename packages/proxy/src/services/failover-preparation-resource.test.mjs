import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { createD1StorageContext } from '@octafuse/core';
import { failoverDispatch } from './failover-dispatch.ts';
import { EMPTY_USAGE } from './proxy.ts';

function repositories() {
  const unexpected = () => { throw Error('Unexpected database operation'); };
  return createD1StorageContext({ prepare: unexpected, batch: unexpected, exec: unexpected, withSession: unexpected, dump: unexpected }).repositories;
}
function route(id = 'p') {
  return { targetId: id, providerId: id, providerName: id, providerModelName: 'model', gatewayModelId: 'model',
    upstreamProtocol: 'openai', upstreamOperation: 'chat', adapter: 'passthrough', providerEndpoints: {},
    providerApiKey: 'synthetic-provider', providerSharedChannelType: null, routeGroup: 'default', routePriority: 1, routeWeight: 1,
    endpoint: { providerSlug: id, modelId: 'model' } };
}
const base = { affinityKey: '', tierKeyPrefix: '', strategy: 'weight_priority', requestDeadlineAtMs: 1100, delegateBeforeUpstreamDispatchToDriver: true };
const byok = { workspaceId: 'w', userId: 'u', apiKeyHash: 'a'.repeat(64) };

for (const site of ['shared', 'byok-keys', 'byok-policy', 'sticky', 'byok-parallel']) {
  for (const stop of ['client', 'deadline']) for (const outcome of ['resolve', 'reject']) {
    test(`failover preparation owns late ${site}/${stop}/${outcome}`, { timeout: 5000 }, async t => {
      t.mock.method(console, 'warn', () => {});
      t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
      const repos = repositories(), parent = new AbortController(), entered = Promise.withResolvers();
      const gates = [], calls = []; let dispatched = 0, receipt, finished = false;
      const delayed = (name, value) => {
        calls.push(name); const gate = Promise.withResolvers(); gates.push({ ...gate, value });
        if (gates.length === (site === 'byok-parallel' ? 2 : 1)) entered.resolve();
        return gate.promise;
      };
      const first = route(), second = route('p2');
      const options = { ...base, registerResourceCompletion: task => { receipt = task; } };
      if (site === 'shared') {
        first.providerSharedChannelType = 'openai'; second.providerSharedChannelType = 'anthropic';
        t.mock.method(repos.sharedKeys, 'listActiveSharedKeysByChannel', channel => delayed(channel, []));
      } else if (site.startsWith('byok')) {
        options.byok = byok;
        t.mock.method(repos.byokKeys, 'listActiveForRequest', () => site !== 'byok-policy' ? delayed('keys', []) : Promise.resolve([]));
        t.mock.method(repos.byokKeys, 'shouldSuppressSharedCapacityForRequest', () => site !== 'byok-keys' ? delayed('policy', false) : Promise.resolve(false));
      } else {
        options.affinityKey = 'synthetic-affinity'; options.routePoolId = 'pool';
        options.sticky = { enabled: true, epoch: 1, idleTtlSeconds: 60 };
        t.mock.method(repos.routePoolSticky, 'getBinding', () => delayed('sticky', null));
      }
      t.after(async () => { for (const g of gates) g.resolve(g.value); if (receipt) await receipt; });
      const pending = failoverDispatch(repos, [first, second], 'openai', async () => { dispatched++; throw Error('Unexpected dispatch'); }, parent.signal, options);
      await entered.promise;
      if (stop === 'client') parent.abort('PRIVATE_CANCEL'); else t.mock.timers.tick(100);
      const result = await pending;
      assert.equal(result.response.status, stop === 'client' ? 499 : 504);
      assert.equal(result.resourceCompletion, receipt);
      assert.equal(result.dispatchBudget.permitsConsumed, 0); assert.equal(result.meta.upstreamOutcomeUnknown, false);
      const completion = receipt.then(value => { finished = true; return value; });
      await tick(); assert.equal(finished, false, 'caller cancellation does not finish the raw read');
      const finish = g => outcome === 'resolve' ? g.resolve(g.value) : g.reject(Error('PRIVATE_LATE_READ'));
      if (site === 'byok-parallel') {
        finish(gates[0]); await tick(); assert.equal(finished, false, 'both concurrent BYOK reads must terminate');
      }
      finish(gates.at(-1));
      assert.equal(await completion, 'confirmed');
      assert.equal(gates.length, site === 'byok-parallel' ? 2 : 1);
      assert.deepEqual(calls, site === 'shared' ? ['openai'] : site === 'byok-parallel' ? ['keys', 'policy'] : [site.replace('byok-', '')]);
      assert.equal(dispatched, 0); assert.doesNotMatch(await result.response.text(), /PRIVATE/);
    });
  }
}

for (const kind of ['json', 'sse', 'empty']) test(`response ${kind} remains readable after preparation ownership seals`, async () => {
  const driver = Promise.withResolvers(); let receipt, finished = false, calls = 0;
  const payload = kind === 'sse' ? 'data: {"ok":true}\n\ndata: [DONE]\n\n' : '{"ok":true}';
  const bytes = new TextEncoder().encode(payload); let index = 0;
  const response = kind === 'empty' ? new Response(null, { status: 204 }) : new Response(new ReadableStream({
    pull(c) { if (index < bytes.length) c.enqueue(bytes.subarray(index, ++index)); else c.close(); },
  }, { highWaterMark: 0 }), { headers: { 'Content-Type': kind === 'sse' ? 'text/event-stream' : 'application/json' } });
  const result = await failoverDispatch(repositories(), [route()], 'openai', async () => {
    calls++; return { response, usagePromise: Promise.resolve(EMPTY_USAGE), upstreamRequestId: null, resourceCompletion: driver.promise };
  }, undefined, { ...base, requestDeadlineAtMs: Date.now() + 10000, registerResourceCompletion: task => { receipt = task; } });
  const completion = receipt.then(value => { finished = true; return value; });
  assert.equal(await result.response.text(), kind === 'empty' ? '' : payload);
  await tick(); assert.equal(finished, false, 'body EOF does not replace the driver cleanup receipt');
  driver.resolve('confirmed'); assert.equal(await completion, 'confirmed'); assert.equal(calls, 1);
});
