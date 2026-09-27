import {parseSseSnapshotFault, type SseSnapshotFault} from './images-sse-snapshot-fault-v2';

export const SSE_CANCEL_OBSERVER_MS = 20_000;
export function sseCancelObservationRow(input: SseSnapshotFault) {
  const probe = parseSseSnapshotFault(`c02-snapshot:${input.runId}:${input.probeId}:${input.mode}`);
  if (!probe || !['before-hold', 'after-hold'].includes(probe.mode)) throw new TypeError('Invalid cancellation observation');
  return {key: 'c02_sse_cancel:' + probe.probeId, description: 'c02-cancel:' + probe.runId,
    value: JSON.stringify({...probe, phase: 'armed'})};
}

/** Staging-only observation of the ORIGINAL incoming signal, not an invented abort.
 * No response reader, no financial writes, no arbitrary request reason/headers in the record.
 * Register waitUntil immediately; the fixed observation window does not extend the platform's
 * own post-disconnect limit or cancel the independently registered financial work.
 */
export function observeSseClientAbort(request: Request, response: Response, db: D1Database,
  context: Pick<ExecutionContext, 'waitUntil'>, input: SseSnapshotFault): void {
  const row = sseCancelObservationRow(input);
  const probe = Object.freeze({runId: input.runId, probeId: input.probeId, mode: input.mode});
  const requestId = response.headers.get('X-Generation-Id');
  if (response.status !== 200 || !response.headers.get('Content-Type')?.startsWith('text/event-stream')
    || !requestId || !/^gen-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(requestId)) return;
  let stopped = false, resolve!: () => void, reject!: (reason: unknown) => void;
  const completion = new Promise<void>((done, fail) => {resolve = done; reject = fail;});
  context.waitUntil(completion);
  const signal = request.signal;
  const stop = () => {stopped = true; clearTimeout(timer); signal.removeEventListener('abort', onAbort);};
  const timer = setTimeout(() => {stop(); resolve();}, SSE_CANCEL_OBSERVER_MS);
  async function record(at: string) {
    // One bounded snapshot of the real write-boundary marker at native abort observation.
    const snapshotValue = await db.prepare(
      'SELECT CASE WHEN length(value)<=2048 THEN value ELSE NULL END AS value FROM system_config WHERE key=? AND description=?'
    ).bind('c02_sse_snapshot:' + probe.probeId, 'c02-snapshot:' + probe.runId).first<string>('value');
    if (typeof snapshotValue !== 'string' || snapshotValue.length > 2048) throw new Error('C02_CANCEL_SNAPSHOT_UNAVAILABLE');
    const next = JSON.stringify({...probe, phase: 'request-aborted', requestId, at, signalAborted: true, snapshotValue});
    const result = await db.prepare('UPDATE system_config SET value=?,updated_at=? WHERE key=? AND description=? AND value=?')
      .bind(next, at, row.key, row.description, row.value).run();
    if (!result.success || result.meta.changes !== 1) throw new Error('C02_CANCEL_OWNERSHIP_UNCONFIRMED');
  }
  function onAbort() {
    if (stopped || !signal.aborted) return;
    const at = new Date().toISOString(); stop();
    // Observe both branches immediately; no late floating rejection or second financial action.
    void record(at).then(resolve, reject);
  }
  signal.addEventListener('abort', onAbort, {once: true});
  if (signal.aborted) onAbort();
}
