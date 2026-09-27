import type { ByokD1MaintenanceControlEnv } from './byok-d1-maintenance-control-env';
import { verifyEmptyBody } from '../../src/runtime/usage-recovery-control';
import { BYOK_MAINTENANCE_ORIGIN, BYOK_MAINTENANCE_PATH } from './byok-d1-maintenance-contract';

const response = (status: number, code: string, receipt?: {runId:string;removedRows:number;statementCount:number}) =>
  Response.json({status:code,retry_safe:false,...(receipt ? {receipt} : {})},
    {status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
/** A scalar gate is only local load containment. Durable one-shot ownership is
 * claimed independently by the receiver, including across isolates. */
export function createByokD1MaintenanceControl() {
  let active = false;
  return {fetch(request: Request, env: ByokD1MaintenanceControlEnv, ctx: Pick<ExecutionContext,'waitUntil'|'access'>): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== BYOK_MAINTENANCE_ORIGIN || url.username || url.password || url.pathname !== BYOK_MAINTENANCE_PATH
      || url.search || url.hash || request.method !== 'POST') return Promise.resolve(response(404,'not_found'));
    if (env.BYOK_MAINTENANCE_CONTROL_ENVIRONMENT !== 'staging' || env.BYOK_MAINTENANCE_CONTROL_ENABLED !== 'true')
      return Promise.resolve(response(503,'disabled'));
    if (!/^[a-f0-9]{64}$/.test(env.BYOK_MAINTENANCE_ACCESS_AUD) || ctx.access?.aud !== env.BYOK_MAINTENANCE_ACCESS_AUD)
      return Promise.resolve(response(403,'forbidden'));
    const authorization = request.headers.get('Authorization') ?? '';
    if (!/^Bearer [a-f0-9]{64}$/.test(authorization)) return Promise.resolve(response(403,'forbidden'));
    if (request.headers.has('Origin') || request.headers.get('X-CinaToken-BYOK-Command') !== 'cleanup-once-v1'
      || request.headers.has('Transfer-Encoding') || ![null,'0'].includes(request.headers.get('Content-Length')))
      return Promise.resolve(response(400,'invalid_command'));
    if (request.signal.aborted) return Promise.resolve(response(409,'cancelled_before_dispatch'));
    if (active) return Promise.resolve(response(503,'busy'));
    active = true;let registered = false;
    const task = Promise.resolve().then(async () => {
      if (!registered) return response(503,'host_rejected');
      const body = await verifyEmptyBody(request);
      if (request.signal.aborted || body === 'cancelled_before_dispatch') return response(409,'cancelled_before_dispatch');
      if (body !== 'empty') return response(body === 'command_timeout' ? 408 : 400,'invalid_command');
      const result = await env.USAGE_RECOVERY.run(authorization.slice(7));
      if (result.status !== 'cleaned') return response(result.status === 'not_authorized' ? 403 : result.status === 'not_admissible' ? 409 : 503,'cleanup_unconfirmed');
      if (typeof result.runId !== 'string' || !/^c02-byok-[a-f0-9]{12}$/.test(result.runId) || !Number.isSafeInteger(result.removedRows) || result.removedRows < 1 || result.removedRows > 1200
        || !Number.isSafeInteger(result.statementCount) || result.statementCount < 1 || result.statementCount > 256) return response(502,'outcome_unknown');
      return response(200,'cleaned',{runId:result.runId,removedRows:result.removedRows,statementCount:result.statementCount});
    }).catch(()=>response(502,'outcome_unknown')).finally(()=>{active=false;});
    try { ctx.waitUntil(task.then(()=>{})); registered = true; } catch { /* task performs no RPC */ }
    return task;
  }};
}
