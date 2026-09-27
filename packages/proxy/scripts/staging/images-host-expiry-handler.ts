import { createImagesStagingGateway } from './images-gateway-handler';

/** Fixed staging-only producer lease and background expiry experiment, never a production default. */
export function createImagesHostExpiryGateway(transport: typeof fetch) {
	return createImagesStagingGateway(transport, {
		imageUsageRecovery: { settlementLeaseSeconds: 5 },
		storageFaultProfile: 'wait-until-expiry',
	});
}
