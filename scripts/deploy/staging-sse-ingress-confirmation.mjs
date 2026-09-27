import assert from 'node:assert/strict';
import {SSE_STAGING_SCOPE} from './staging-sse-reconciliation.mjs';
import {SSE_RECOVERY_ACCESS_SCOPE} from './staging-sse-recovery-access-v2.mjs';
import {assertOperatorSample} from './staging-sse-operator-clock.mjs';

const paths = new Set([SSE_STAGING_SCOPE, SSE_RECOVERY_ACCESS_SCOPE].map(s => `/workers/scripts/${s.worker}/subdomain`));
const closed = value => value.enabled === false && value.previews_enabled === false;
function state(value) {
  assert.ok(value && typeof value === 'object');
  assert.equal(typeof value.enabled, 'boolean'); assert.equal(typeof value.previews_enabled, 'boolean');
  return {enabled: value.enabled, previews_enabled: value.previews_enabled};
}

/** Adapter for the existing fixed-scope closer, not an automatic mutation retry.
 * One close POST per path per instance. Its acknowledgement is never closure
 * evidence: at most three GETs, 4s per GET / 15s total confirmation window.
 * api must honor its fourth argument's AbortSignal and debit every physical call.
 * Only same-path GETs are retried. All original write/read failures are journaled.
 */
export function withSseIngressConfirmation({api, clock, persist}) {
  assert.equal(typeof api, 'function'); assert.equal(typeof persist, 'function');
  assertOperatorSample(clock.sample(), clock.clockId);
  const attempts = new Map();
  async function confirm(path, marker) {
    assert.ok(!marker.busy && !marker.failed, 'Closure confirmation already active or exhausted'); marker.busy = true;
    try {
      for (let n = 0; n < 3; n++) {
        if (n) await clock.waitUntil(clock.after(clock.sample(), 1000));
        const remaining = clock.remaining(marker.deadline);
        assert.ok(remaining > 0, 'Closure confirmation window expired');
        const event = {step: 'ingress-confirmation-read', path, attempt: n + 1, started: clock.sample()};
        await persist(structuredClone(event));
        assert.ok(clock.remaining(marker.deadline) > 0, 'Closure confirmation window expired before read');
        const ac = new AbortController(); let timer, observed;
        const timedOut = new Promise((_, reject) => { timer = setTimeout(() => { ac.abort(); reject(Error('read-timeout')); }, Math.min(4000, clock.remaining(marker.deadline))); });
        try {
          observed = state(await Promise.race([api(path, 'GET', undefined, {signal: ac.signal}), timedOut]));
          event.state = observed; event.result = closed(observed) ? 'CLOSED' : 'NOT_CLOSED';
        } catch { event.result = ac.signal.aborted ? 'TIMEOUT' : 'READ_FAILED'; }
        finally { clearTimeout(timer); ac.abort(); }
        event.finished = clock.sample();
        if (clock.remaining(marker.deadline) <= 0) { event.result = 'DEADLINE'; observed = undefined; }
        await persist(structuredClone(event));
        if (observed && closed(observed)) { marker.confirmed = true; return observed; }
      }
      throw Error('Staging ingress closure unconfirmed after bounded reads');
    } catch (error) { marker.failed = true; throw error; }
    finally { marker.busy = false; }
  }
  return async (path, method = 'GET', body) => {
    if (!paths.has(path)) return api(path, method, body);
    if (method === 'POST') {
      assert.deepEqual(body, {enabled: false, previews_enabled: false});
      assert.ok(!attempts.has(path), 'Never replay an uncertain close write');
      const marker = {busy: false, failed: false, writing: true}; attempts.set(path, marker);
      const event = {step: 'ingress-close-write', path, started: clock.sample(), result: 'PENDING'};
      await persist(structuredClone(event));
      try { await api(path, 'POST', body); event.result = 'ACK'; }
      catch { event.result = 'ACK_UNCERTAIN'; }
      event.finished = clock.sample(); marker.deadline = clock.after(event.finished, 15000);
      await persist(structuredClone(event));
      marker.writing = false;
      // The existing closer always GETs next, including after this uncertain ACK.
      // Returning is not a closure claim; the bounded read path below supplies it.
      return undefined;
    }
    assert.equal(method, 'GET');
    const marker = attempts.get(path);
    assert.ok(!marker?.writing, 'Close write or its journal is still pending');
    if (marker && !marker.confirmed) return confirm(path, marker);
    // Already-confirmed markers never substitute for a new final read.
    return api(path);
  };
}
