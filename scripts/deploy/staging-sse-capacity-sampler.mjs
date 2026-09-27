import assert from 'node:assert/strict';
import {assertSseCapacityObservation, classifySseCapacityObservation} from './staging-sse-capacity-evidence.mjs';
import {assertOperatorSample} from './staging-sse-operator-clock.mjs';

export const SSE_CAPACITY_SAMPLE_URL = 'https://cinatoken-proxy-staging.cinagroup.workers.dev/__staging/sse-capacity';
const instanceHeader = 'x-c02-capacity-instance';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const stages = ['baseline', 'held', 'post-cancel', 'post-recovery'];
const limits = [1, 1, 3, 1];
const snapshot = value => Object.freeze(structuredClone(value));
const cancel = body => { try { void body?.cancel().catch(() => {}); } catch {} };

/** Operator-only, one after-hold window. No inference, RPC, retry or cloud writes.
 * reserve() synchronously debits the shared HTTP budget; persist() must durably
 * retain the initial attempt before fetch. Uncertain attempts remain consumed.
 * Pool identity is not routing affinity or proof of native cancellation.
 */
export function createSseCapacitySampler({clock, fetchImpl = fetch, reserve, persist}) {
  assert.equal(typeof reserve, 'function');
  assert.equal(typeof persist, 'function');
  assert.equal(typeof fetchImpl, 'function');
  assertOperatorSample(clock.sample(), clock.clockId);
  const counts = [0, 0, 0, 0];
  let stageIndex = 0, busy = false, poisoned = false, attempt = 0, pinnedInstanceId;

  return Object.freeze({
    async sample({stage, requestInstanceId, accessHeaders}) {
      assert.ok(!busy && !poisoned, 'Sampler busy or persistence/budget failed');
      const index = stages.indexOf(stage);
      assert.ok(index >= stageIndex && index <= stageIndex + 1 && index >= 0, 'Invalid census stage order');
      if (index > stageIndex) assert.ok(counts[stageIndex] > 0, 'Previous census stage missing');
      assert.ok(counts[index] < limits[index], 'Census stage attempt budget exhausted');
      if (stage === 'baseline') assert.equal(requestInstanceId, undefined);
      else assert.match(requestInstanceId, uuid);
      if (pinnedInstanceId !== undefined) assert.equal(requestInstanceId, pinnedInstanceId, 'Request pool identity changed');
      const headers = new Headers(accessHeaders);
      assert.deepEqual([...headers.keys()].sort(), ['cf-access-client-id', 'cf-access-client-secret']);
      for (const value of headers.values()) assert.ok(value.length > 0 && value.length <= 4096);
      busy = true;
      stageIndex = index;
      counts[index]++;
      if (stage === 'held') pinnedInstanceId = requestInstanceId;
      const record = {kind: 'capacity', attempt: ++attempt, stage, started: clock.sample(), result: 'PENDING'};
      if (requestInstanceId !== undefined) record.requestInstanceId = requestInstanceId;
      let reader, response, timer, failureCode = 'transport';
      const abort = new AbortController();
      try {
        // A failed write-ahead journal or shared-budget reservation fails closed.
        try { reserve(); await persist(snapshot(record)); }
        catch { poisoned = true; throw Error('Capacity write-ahead journal or shared budget failed'); }
        const deadline = clock.after(clock.sample(), 5000);
        const expired = new Promise((_, reject) => {
          timer = setTimeout(() => { failureCode = 'timeout'; abort.abort(); reject(Error('timeout')); }, clock.remaining(deadline));
        });
        const work = (async () => {
          response = await fetchImpl(SSE_CAPACITY_SAMPLE_URL, {
            method: 'GET', headers, redirect: 'manual', cache: 'no-store', signal: abort.signal,
          });
          if (abort.signal.aborted) { cancel(response.body); throw Error('expired'); }
          record.status = response.status;
          failureCode = 'response-contract';
          assert.equal(response.status, 200);
          assert.equal(response.redirected, false);
          assert.ok(!response.url || response.url === SSE_CAPACITY_SAMPLE_URL);
          assert.match(response.headers.get('content-type') ?? '', /^application\/json(?:;\s*charset=utf-8)?$/i);
          assert.equal(response.headers.get('cache-control'), 'no-store');
          assert.match(response.headers.get(instanceHeader) ?? '', uuid);
          const length = response.headers.get('content-length');
          if (length !== null) assert.ok(/^(0|[1-9][0-9]*)$/.test(length) && Number(length) <= 2048);
          assert.ok(response.body);
          reader = response.body.getReader();
          const chunks = [];
          let bytes = 0;
          failureCode = 'body-contract';
          for (;;) {
            const next = await reader.read();
            abort.signal.throwIfAborted();
            if (next.done) break;
            bytes += next.value.byteLength;
            assert.ok(bytes <= 2048);
            // Copy only bounded content; never retain an upstream backing buffer.
            chunks.push(Buffer.from(next.value));
          }
          record.bytes = bytes;
          const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks, bytes)));
          const observed = assertSseCapacityObservation(value);
          assert.equal(response.headers.get(instanceHeader), observed.instanceId);
          record.observation = stage === 'baseline'
            ? {state: 'baseline', observed}
            : classifySseCapacityObservation(requestInstanceId, observed);
        })();
        try { await Promise.race([work, expired]); record.result = 'PASS'; }
        catch { record.result = 'FAIL'; record.error = failureCode; }
        clearTimeout(timer);
        // Never persist arbitrary exception messages, response bodies or auth headers.
        record.finished = clock.sample();
        assertOperatorSample(record.finished, record.started.clockId);
        assert.ok(record.finished.monoMs >= record.started.monoMs);
        const result = snapshot(record);
        try { await persist(result); }
        catch { poisoned = true; throw Error('Capacity final journal failed'); }
        return result;
      } finally {
        clearTimeout(timer);
        abort.abort();
        if (reader) { try { void reader.cancel().catch(() => {}); } catch {} }
        else cancel(response?.body);
        busy = false;
      }
    },
  });
}
