/** Provider 协议端点字段（供路由校验）。 */
export type ProviderProtocolBases = {
	id: string;
	/** `providers.endpoints` JSON */
	endpoints: string | null;
};

/** Cross-driver/D1-safe maximum for provider id batch reads. */
export const MAX_PROVIDER_ID_BATCH_SIZE = 100;
