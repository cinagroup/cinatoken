import type { ByokD1GatewayEnv } from './byok-d1-gateway-env';
function bindingContract(env: ByokD1GatewayEnv) {
  const db: D1Database = env.BYOK_DB;
  // @ts-expect-error This candidate has no inference/provider service binding.
  env.UPSTREAM;
  // @ts-expect-error Cleanup belongs to the independent receiver, not the gateway.
  env.USAGE_RECOVERY;
  // @ts-expect-error No general application DB alias on this dedicated surface.
  env.DB;
  return db;
}
void bindingContract;
