import { imageProbeRow, type ImageProbe } from './images-probe-contract';

type StopReason = 'request_abort' | 'response_cancel' | 'expired' | 'released';
type ProbeEvent = { phase: 'started' | 'body-prefix' | 'terminal'; at: number; reason?: StopReason; signalAborted: boolean };

/** Bounded observer kept alive explicitly; this changes the synthetic supplier, not the Gateway. */
export async function imageProbeResponse({ probe, request, db, context, receipt, holdMs = 15000 }: {
  probe: ImageProbe; request: Request; db: Pick<D1Database, 'prepare'>;
  context: Pick<ExecutionContext, 'waitUntil'>; receipt: string; holdMs?: number;
}): Promise<Response> {
  if (!Number.isSafeInteger(holdMs) || holdMs < 1 || holdMs > 15000) throw new Error('Bounded probe duration required');
  const row = imageProbeRow(probe), events: ProbeEvent[] = [];
  let current = row.value, writes = Promise.resolve();
  function transition(phase: ProbeEvent['phase'], reason?: StopReason): Promise<void> {
    writes = writes.then(async () => {
      events.push({ phase, at: Date.now(), ...(reason ? { reason } : {}), signalAborted: request.signal.aborted });
      if (events.length > 3) throw new Error('Probe event bound exceeded');
      const next = JSON.stringify({ ...probe, phase, events });
      const result = await db.prepare('UPDATE system_config SET value=?,updated_at=? WHERE key=? AND description=? AND value=?')
        .bind(next, new Date().toISOString(), row.key, row.description, current).run();
      if (result.meta.changes !== 1) throw new Error('Probe not armed or ownership/state changed');
      current = next;
    });
    return writes;
  }
  await transition('started');
  let resolveStop!: (reason: StopReason) => void, settled = false;
  const stopped = new Promise<StopReason>(resolve => { resolveStop = resolve; });
  const onAbort = () => stop('request_abort');
  const timer = setTimeout(() => stop(probe.mode === 'release' ? 'released' : 'expired'), probe.mode === 'release' ? Math.min(250, holdMs) : holdMs);
  function stop(reason: StopReason): void {
    if (settled) return;
    settled = true; clearTimeout(timer); request.signal.removeEventListener('abort', onAbort); resolveStop(reason);
  }
  request.signal.addEventListener('abort', onAbort, { once: true });
  if (request.signal.aborted) onAbort();
  const completion = stopped.then(async reason => { await transition('terminal', reason); return reason; });
  context.waitUntil(completion);
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Request-ID': receipt };
  if (probe.mode !== 'body') {
    const reason = await completion;
    return reason === 'request_abort' ? new Response(null, { status: 499, headers })
      : new Response('{"data":[{"b64_json":"AQID"}],"usage":{"input_tokens":3,"output_tokens":7}}', { headers });
  }
  let prefixSent = false;
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!prefixSent) {
        if (settled) {
          const reason = await completion;
          if (reason === 'request_abort' || reason === 'response_cancel') { controller.error(new DOMException('Synthetic response stopped', 'AbortError')); return; }
        }
        prefixSent = true;
        controller.enqueue(new TextEncoder().encode('{"data":['));
        if (!settled) await transition('body-prefix');
        return;
      }
      const reason = await completion;
      if (reason === 'request_abort' || reason === 'response_cancel') { controller.error(new DOMException('Synthetic response stopped', 'AbortError')); return; }
      controller.enqueue(new TextEncoder().encode('{"b64_json":"AQID"}],"usage":{"input_tokens":3,"output_tokens":7}}'));
      controller.close();
    },
    cancel() { stop('response_cancel'); return completion.then(() => undefined); },
  }, { highWaterMark: 0 }), { headers });
}
