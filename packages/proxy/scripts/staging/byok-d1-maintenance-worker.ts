import { WorkerEntrypoint } from 'cloudflare:workers';
import type { ByokD1MaintenanceEnv } from './byok-d1-maintenance-env';
import { runByokD1Maintenance, type ByokMaintenanceResult } from './byok-d1-maintenance-host';

const notFound = () => new Response('Not found',{status:404,headers:{'Cache-Control':'no-store'}});
/** Candidate for the EXISTING staging recovery service, never a new resource. */
export class UsageRecovery extends WorkerEntrypoint<ByokD1MaintenanceEnv> {
  run(token: string): Promise<ByokMaintenanceResult> {
    if (arguments.length !== 1) return Promise.resolve({status:'invalid_arguments'});
    return runByokD1Maintenance(this.env.RECOVERY_DB,
      this.env.BYOK_MAINTENANCE_ENVIRONMENT === 'staging' && this.env.BYOK_MAINTENANCE_ENABLED === 'true',token,this.ctx);
  }
  fetch() { return notFound(); }
}
export default {fetch:notFound} satisfies ExportedHandler<ByokD1MaintenanceEnv>;
