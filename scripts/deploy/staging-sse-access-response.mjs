import assert from 'node:assert/strict';
import {assertSseCapacityObservation} from './staging-sse-capacity-evidence.mjs';

const cancel = body => { try { void body?.cancel().catch(() => {}); } catch {} };

/** Interpret one already-issued Access check. Does not fetch, retry, echo pages,
 * follow redirects, or run the recovery command. Non-success pages are discarded
 * without reading; only the expected authenticated JSON has a body budget.
 */
export async function inspectSseAccessResponse(response, {target, auth, signal}) {
  assert.ok(['gateway', 'controller'].includes(target));
  assert.ok(['none', 'invalid', 'valid'].includes(auth));
  const rawType = response.headers.get('content-type') ?? '';
  const json = /^application\/json(?:;\s*charset=utf-8)?$/i.test(rawType);
  const mediaType = json ? 'json' : /^text\/html(?:;|$)/i.test(rawType) ? 'html' : 'other';
  const record = {status: response.status, mediaType, verdict: 'FAIL', bodyDisposition: 'discarded'};
  const expected = auth === 'valid' && response.status === (target === 'gateway' ? 200 : 400);
  if (signal?.aborted || response.redirected) {
    cancel(response.body); return {...record, error: signal?.aborted ? 'cancelled' : 'redirected'};
  }
  if (!expected) {
    cancel(response.body);
    if (auth !== 'valid' && [401, 403].includes(response.status) && !rawType.toLowerCase().includes('json')) record.verdict = 'PASS';
    else if ([302, 403, 404].includes(response.status)) record.verdict = 'RETRY';
    return record;
  }
  let reader, timer, stopped = false;
  const max = target === 'gateway' ? 2048 : 512;
  let onAbort;
  try {
    assert.ok(json); assert.equal(response.headers.get('cache-control'), 'no-store');
    const declared = response.headers.get('content-length');
    if (declared !== null) assert.ok(/^(0|[1-9][0-9]*)$/.test(declared) && Number(declared) <= max);
    assert.ok(response.body); reader = response.body.getReader();
    const interrupted = new Promise((_, reject) => {
      onAbort = () => { stopped = true; reject(Error('cancelled')); };
      signal?.addEventListener('abort', onAbort, {once: true});
      if (signal?.aborted) onAbort();
      timer = setTimeout(() => { stopped = true; reject(Error('timeout')); }, 5000);
    });
    const read = (async () => {
      let bytes = 0; const parts = [];
      for (;;) {
        const next = await reader.read();
        if (stopped) throw Error('stopped');
        if (next.done) break;
        bytes += next.value.byteLength; assert.ok(bytes <= max); parts.push(Buffer.from(next.value));
      }
      const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(parts, bytes)));
      if (target === 'gateway') {
        const capacity = assertSseCapacityObservation(value);
        assert.equal(response.headers.get('x-c02-capacity-instance'), capacity.instanceId);
        return {bytes, capacity};
      }
      assert.deepEqual(value, {status: 'invalid_command', reason: 'command_header'});
      return {bytes, commandRejected: true};
    })();
    const value = await Promise.race([read, interrupted]);
    return {...record, ...value, verdict: 'PASS', bodyDisposition: 'validated-json'};
  } catch {
    return {...record, error: stopped ? 'interrupted' : 'response-contract'};
  } finally {
    stopped = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
    if (reader) { try { void reader.cancel().catch(() => {}); } catch {} }
    else cancel(response.body);
  }
}
