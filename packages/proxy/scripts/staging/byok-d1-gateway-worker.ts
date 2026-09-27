import type { ByokD1GatewayEnv } from './byok-d1-gateway-env';
import { createByokD1Gateway } from './byok-d1-gateway';

export default createByokD1Gateway() satisfies ExportedHandler<ByokD1GatewayEnv>;
