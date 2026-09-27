import { runDedicatedSharedEarningScanner,
	type DedicatedSharedEarningScannerBindings } from './postgres-shared-earning-scanner';

/**
 * Review-only scheduled entry point. Its Wrangler config has no HTTP route,
 * D1, general HYPERDRIVE, provider secret, service binding, or Queue consumer.
 */
export const sharedEarningScannerWorker = {
	fetch() {
		return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
	},
	scheduled(controller, environment, context) {
		context.waitUntil(runDedicatedSharedEarningScanner(controller, environment));
	},
} satisfies ExportedHandler<DedicatedSharedEarningScannerBindings>;

export default sharedEarningScannerWorker;
