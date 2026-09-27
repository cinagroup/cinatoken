import type { ByokD1GatewayEnv } from './byok-d1-gateway-env';
import { verifyEmptyBody } from '../../src/runtime/usage-recovery-control';
import { BYOK_D1_CASES } from './byok-d1-acceptance';
import { BYOK_D1_ORIGIN, handleByokD1OneShot } from './byok-d1-one-shot';
import { BYOK_D1_INSTALL_ACTION, parseByokD1InstallGrant } from './byok-d1-install-contract';
import { installByokD1Fence } from './byok-d1-install';

const prefix = '/__staging/byok-d1/';
const response = (status: number, code: string) => Response.json({ code, retry_safe: false }, {
  status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});

/** Dedicated alternative for the existing staging gateway, not a product API.
 * The operator must verify the bound DB before enabling Access/ingress. A
 * separately hashed short-term grant can install the fixed closed fence before
 * control arming. Cases still require durable control. No provisioning/reset.
 * Only scalar load gates are shared; DB CAS, not these gates, owns each case.
 */
export function createByokD1Gateway() {
  let caseActive = false;
  let stopActive = false;
  return {
    fetch(request: Request, env: ByokD1GatewayEnv, ctx: Pick<ExecutionContext, 'waitUntil' | 'access'>): Promise<Response> {
      let url: URL;
      try {
        if (request.url.length > 2048) throw new TypeError();
        url = new URL(request.url);
      } catch { return Promise.resolve(response(404, 'not_available')); }
      const action = url.pathname.slice(prefix.length), stop = action === 'stop', install = action === BYOK_D1_INSTALL_ACTION;
      if (url.origin !== BYOK_D1_ORIGIN || url.username || url.password || url.search || url.hash
        || !url.pathname.startsWith(prefix) || (!stop && !install && !BYOK_D1_CASES.some(id => id === action))
        || request.method !== 'POST') return Promise.resolve(response(404, 'not_available'));
      if (env.BYOK_GATEWAY_ENVIRONMENT !== 'staging' || env.BYOK_GATEWAY_ENABLED !== 'true')
        return Promise.resolve(response(503, 'disabled'));
      const audience = env.BYOK_GATEWAY_ACCESS_AUD;
      if (typeof audience !== 'string' || !/^[a-f0-9]{64}$/.test(audience) || ctx.access?.aud !== audience)
        return Promise.resolve(response(403, 'forbidden'));
      const authorization = request.headers.get('Authorization') ?? '';
      if (!/^Bearer [a-f0-9]{64}$/.test(authorization)) return Promise.resolve(response(403, 'forbidden'));
      if (install) {
        try { parseByokD1InstallGrant(env.BYOK_GATEWAY_INSTALL_GRANT); }
        catch { return Promise.resolve(response(503, 'install_disabled')); }
      }
      if (request.headers.has('Origin') || request.headers.has('Transfer-Encoding')
        || ![null, '0'].includes(request.headers.get('Content-Length'))
        || request.headers.get('X-CinaToken-BYOK-Command') !== (stop ? 'stop-once-v1' : install ? 'install-fence-once-v1' : 'case-once-v1'))
        return Promise.resolve(response(400, 'invalid_command'));
      if (request.signal.aborted) return Promise.resolve(response(409, 'cancelled_before_dispatch'));
      // A stuck case/body must not prevent STOP from sealing new admissions.
      // STOP does not cancel active SQL or authorize cleanup of an unknown case.
      if (stop ? stopActive : caseActive) return Promise.resolve(response(503, 'busy'));
      if (stop) stopActive = true; else caseActive = true;
      let registered = false;
      const task = Promise.resolve().then(async () => {
        if (!registered) return response(503, 'host_rejected');
        if (request.signal.aborted) return response(409, 'cancelled_before_dispatch');
        const body = await verifyEmptyBody(request);
        if (request.signal.aborted || body === 'cancelled_before_dispatch') return response(409, 'cancelled_before_dispatch');
        if (body !== 'empty') return response(body === 'command_timeout' ? 408 : 400, 'invalid_command');
        // A native empty HTTP POST can still have a byte stream. Only verified
        // EOF permits canonicalization; never discard a caller's nonempty body.
        const command = new Request(request.url, { method: 'POST', headers: { Authorization: authorization }, signal: request.signal });
        const result = install ? await installByokD1Fence(command, env.BYOK_DB, env.BYOK_GATEWAY_INSTALL_GRANT, ctx)
          : await handleByokD1OneShot(command, env.BYOK_DB, ctx);
        result.headers.set('X-Content-Type-Options', 'nosniff');
        return result;
      }).catch(() => response(503, 'outcome_unknown')).finally(() => {
        if (stop) stopActive = false; else caseActive = false;
      });
      // Own body cancellation and the downstream handler before either starts.
      try { ctx.waitUntil(task.then(() => {})); registered = true; } catch { /* zero body/DB work */ }
      return task;
    },
  };
}
