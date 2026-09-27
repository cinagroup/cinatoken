import type { ByokD1MaintenanceEnv } from './byok-d1-maintenance-env';
import type { ByokD1MaintenanceControlEnv } from './byok-d1-maintenance-control-env';
import type { ByokMaintenanceResult } from './byok-d1-maintenance-host';
export async function checkByokBindings(env: ByokD1MaintenanceControlEnv, receiver: ByokD1MaintenanceEnv) {
  const result: ByokMaintenanceResult = await env.USAGE_RECOVERY.run('a'.repeat(64));
  receiver.RECOVERY_DB.prepare('SELECT 1');
  // @ts-expect-error The generated controller must never acquire a direct D1 binding.
  env.RECOVERY_DB;
  // @ts-expect-error No caller-selected DB, baseline or SQL is an RPC argument.
  env.USAGE_RECOVERY.run('a'.repeat(64), 'DELETE FROM users');
  return result;
}
