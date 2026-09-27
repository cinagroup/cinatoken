import type { ByokD1MaintenanceControlEnv } from './byok-d1-maintenance-control-env';
import { createByokD1MaintenanceControl } from './byok-d1-maintenance-control';
const control = createByokD1MaintenanceControl();
export default {fetch(request,env,ctx){return control.fetch(request,env,ctx);}} satisfies ExportedHandler<ByokD1MaintenanceControlEnv>;
