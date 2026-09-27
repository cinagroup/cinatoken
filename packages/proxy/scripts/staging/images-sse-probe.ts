import { imageSseRow, type ImageSseMode, type ImageSseProbe } from './images-sse-probe-contract';

// Fixed above the gateway's real five-minute deadline. Never supplied by a request.
export const IMAGE_SSE_HOLD_MS = 315000;
const encoder = new TextEncoder();
const frame = (value: object) => `data: ${JSON.stringify(value)}\n\n`;
const done = 'data: [DONE]\n\n';
const completed = { type: 'image_generation.completed', b64_json: 'AQID',
  usage: { input_tokens: 3, output_tokens: 7, total_tokens: 10 } };
const partial = { type: 'image_generation.partial_image', partial_image_index: 0, b64_json: 'AQID' };
const providerError = { type: 'error', error: { message: 'Synthetic refusal', code: 'image_content_policy_violation',
  metadata: { request_id: 'spoofed-provider', retry_safe: true, outcome_unknown: false, private: 'PRIVATE_DETAIL' } } };
export function imageSseFrames(mode: ImageSseMode): string[] {
  switch (mode) {
    case 'success': return [frame(completed), done];
    case 'provider-error': return [frame(providerError), done];
    case 'partial-provider-error': return [frame(partial), frame(providerError), done];
    case 'invalid-json': return ['data: invalid\n\n', done];
    case 'early-eof': return [frame(completed)];
    case 'usage-limit': return [frame({ ...completed, usage: { opaque: 'x'.repeat(65537) } }), done];
    case 'property-limit': return [frame({ ...completed, ['x'.repeat(257)]: 0 }), done];
    case 'hold': return [frame(partial)];
  }
}
type StopReason = 'eof' | 'request_abort' | 'response_cancel' | 'expired' | 'observer_error';
type Event = { phase: 'started' | 'body-prefix' | 'terminal'; at: number; signalAborted: boolean; reason?: StopReason };

/** Single-use D1 CAS observer. This records enqueue/termination, NOT buyer receipt or settlement. */
export async function imageSseProbeResponse({ probe, request, db, context, receipt }: {
  probe: ImageSseProbe; request: Request; db: Pick<D1Database, 'prepare'>;
  context: Pick<ExecutionContext, 'waitUntil'>; receipt: string;
}): Promise<Response> {
  const row = imageSseRow(probe), events: Event[] = [];
  let current = row.value, writes = Promise.resolve();
  function transition(phase: Event['phase'], reason?: StopReason): Promise<void> {
    writes = writes.then(async () => {
      events.push({ phase, at: Date.now(), signalAborted: request.signal.aborted, ...(reason ? { reason } : {}) });
      if (events.length > 3) throw new Error('SSE observer event limit exceeded');
      const next = JSON.stringify({ ...probe, phase, events });
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
  const frames = imageSseFrames(probe.mode); let index = 0, cancelled = false;
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!reason && index < frames.length) {
          if (index === 0) await transition('body-prefix');
          // Cancellation may race the D1 acknowledgement; never enqueue into a cancelled stream.
          if (cancelled) return;
          if (!reason) { controller.enqueue(encoder.encode(frames[index++])); return; }
        }
        if (!reason && probe.mode !== 'hold') stop('eof');
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
