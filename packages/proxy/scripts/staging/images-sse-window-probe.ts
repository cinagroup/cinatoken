import { imageSseRow, type ImageSseProbe } from './images-sse-probe-contract';

// Fixed above the gateway's real five-minute deadline. Never supplied by a request.
export const IMAGE_SSE_HOLD_MS = 315000;
const encoder = new TextEncoder();
const frame = (value: object) => `data: ${JSON.stringify(value)}\n\n`;
const done = 'data: [DONE]\n\n';
const completed = { type: 'image_generation.completed', b64_json: 'AQID',
  usage: { input_tokens: 3, output_tokens: 7, total_tokens: 10 } };
type StopReason = 'eof' | 'request_abort' | 'response_cancel' | 'expired' | 'observer_error';
type Event = { phase: 'started' | 'body-prefix' | 'completed-enqueued' | 'done-enqueued' | 'terminal'; at: number; signalAborted: boolean; reason?: StopReason };

/** Independent staging-only temporal profile. Same bounded identity/CAS contract as the old probe.
 * success means completed + DONE then hold; hold means completed without DONE then hold.
 * Never changes gateway framing, acceptance or financial code. */
export async function imageSseWindowProbeResponse({ probe, request, db, context, receipt }: {
  probe: ImageSseProbe; request: Request; db: Pick<D1Database, 'prepare'>;
  context: Pick<ExecutionContext, 'waitUntil'>; receipt: string;
}): Promise<Response> {
  if (probe.mode !== 'success' && probe.mode !== 'hold') throw new Error('Unsupported completed-window mode');
  const windowProfile = probe.mode === 'success' ? 'completed-and-done' : 'completed-without-done';
  const row = imageSseRow(probe), events: Event[] = [];
  let current = row.value, writes = Promise.resolve();
  function transition(phase: Event['phase'], reason?: StopReason): Promise<void> {
    writes = writes.then(async () => {
      events.push({ phase, at: Date.now(), signalAborted: request.signal.aborted, ...(reason ? { reason } : {}) });
      if (events.length > 5) throw new Error('SSE observer event limit exceeded');
      const next = JSON.stringify({ ...probe, windowProfile, phase, events });
      const result = await db.prepare('UPDATE system_config SET value=?,updated_at=? WHERE key=? AND description=? AND value=?')
        .bind(next, new Date().toISOString(), row.key, row.description, current).run();
      if (result.meta.changes !== 1) throw new Error('SSE probe not armed or ownership/state changed');
      current = next;
    });
    return writes;
  }
  await transition('started');
  let reason: StopReason | undefined, resolveStop!: () => void;
  const stopped = new Promise<void>(resolve => { resolveStop = resolve; });
  const onAbort = () => stop('request_abort');
  const timer = setTimeout(() => stop('expired'), IMAGE_SSE_HOLD_MS);
  function stop(value: StopReason): void {
    if (reason) return;
    reason = value; clearTimeout(timer); request.signal.removeEventListener('abort', onAbort); resolveStop();
  }
  const completion = stopped.then(() => transition('terminal', reason));
  context.waitUntil(completion);
  request.signal.addEventListener('abort', onAbort, { once: true });
  if (request.signal.aborted) onAbort();
  const frames = probe.mode === 'success' ? [frame(completed), done] : [frame(completed)]; let index = 0, cancelled = false;
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!reason && index < frames.length) {
          if (index === 0) await transition('body-prefix');
          // Cancellation may race the D1 acknowledgement; never enqueue into a cancelled stream.
          if (cancelled) return;
          if (!reason) {
            controller.enqueue(encoder.encode(frames[index++]));
            // Records enqueue, not buyer receipt; never infer cancellation causality from this alone.
            await transition(index === 1 ? 'completed-enqueued' : 'done-enqueued');
            return;
          }
        }
        // Both profiles intentionally keep the provider stream open. Only cancellation or the fixed cap ends it.
        await completion;
        if (cancelled) return;
        if (reason === 'eof') controller.close();
        else controller.error(new DOMException('Synthetic SSE stopped', 'AbortError'));
      } catch (error) {
        stop('observer_error');
        if (!cancelled) controller.error(error);
      }
    },
    cancel() { cancelled = true; stop('response_cancel'); return completion; },
  }, { highWaterMark: 0 }), { headers: {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Request-ID': receipt,
  } });
}
