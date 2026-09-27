import { postgresInitializationCleanup } from '@octafuse/core';

/** Node-process owner, not Workers request state. No automatic replay: a new
 * caller may initialize again only after the previous failure is not quarantined. */
export function createSharedStorageInitializer<Input, Output>(initialize: (input: Input) => Promise<Output>) {
	let pending: Promise<Output> | null = null;
	return (input: Input): Promise<Output> => {
		if (!pending) {
			pending = Promise.resolve().then(() => initialize(input)).catch(error => {
				// Keep an unconfirmed failed client quarantined until process restart.
				// Resetting here would let every new request allocate another client.
				if (postgresInitializationCleanup(error) !== 'unconfirmed') pending = null;
				throw error;
			});
		}
		return pending;
	};
}
