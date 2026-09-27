/// <reference path="./images-env.d.ts" />
import { env } from 'cloudflare:workers';
import { createImagesStagingGateway } from './images-gateway-handler';

// Separate opt-in artifact. Production and legacy staging do not import this entry.
// No public command or binding can toggle recovery or invoke its consumer.
export default createImagesStagingGateway(
	(input, init) => env.IMAGE_UPSTREAM.fetch(input, init),
	{ imageUsageRecovery: { settlementLeaseSeconds: 30 } },
);
