import { createImagesStagingGateway } from './images-gateway-handler';

/** Separate bounded experiment, not a production lease recommendation or user toggle. */
export function createImagesFencingGateway(transport: typeof fetch) {
	return createImagesStagingGateway(transport, {
		imageUsageRecovery: { settlementLeaseSeconds: 5 },
		storageFaultPolls: 40,
	});
}
