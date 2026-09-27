/// <reference path="./images-env.d.ts" />
import { createWorkerHandler } from '../../src/runtime/worker-handler';
import type { WorkerAppOptions } from '../../src/runtime/workers';
import { UPSTREAM_ORIGIN, UPSTREAM_PATH } from './images-upstream';
import { IMAGE_STORAGE_FAULT_HEADER, parseImageStorageFault } from './images-storage-fault-contract';
import { withImageStorageFault } from './images-storage-fault';

/** Fixed private transport; never fall back to native fetch or follow redirects. */
export function privateImageTransport(transport: typeof fetch): typeof fetch {
	return (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.origin !== UPSTREAM_ORIGIN || url.search || url.hash || url.username || url.password
			|| !UPSTREAM_PATH.test(url.pathname) || init?.method !== 'POST' || init.redirect !== 'manual') {
			throw new Error('Private Images fixture transport refused an unexpected destination');
		}
		return transport(input, init);
	};
}

/** Same gateway and one-shot D1 probe for legacy and explicitly opted-in staging. */
export function createImagesStagingGateway(
	transport: typeof fetch,
	options?: Pick<WorkerAppOptions, 'imageUsageRecovery'> & { storageFaultPolls?: 20 | 40; storageFaultProfile?: 'wait-until-expiry' },
) {
	// Fixed server-side choices only; never read observation duration from a request or binding.
	const polls = options?.storageFaultPolls ?? 20;
	if (polls !== 20 && polls !== 40) throw new RangeError('Invalid staging storage observation profile');
	const waitUntilExpiry = options?.storageFaultProfile === 'wait-until-expiry';
	if (options?.storageFaultProfile !== undefined && (!waitUntilExpiry || options.imageUsageRecovery?.settlementLeaseSeconds !== 5)) {
		throw new RangeError('Invalid staging host expiry profile');
	}
	const fencing = polls === 40 && options?.imageUsageRecovery?.settlementLeaseSeconds === 5;
	const handler = createWorkerHandler({
		imageFetch: privateImageTransport(transport),
		imageUsageRecovery: options?.imageUsageRecovery,
	});
	return {
		...handler,
		fetch(request, bindings, context) {
			const value = request.headers.get(IMAGE_STORAGE_FAULT_HEADER);
			if (value === null) return handler.fetch(request, bindings, context);
			const probe = parseImageStorageFault(value);
			if (!probe || !bindings.DB || bindings.DATABASE_DRIVER !== 'd1') {
				return new Response('Invalid staging storage probe', { status: 400 });
			}
			if (waitUntilExpiry && (request.method !== 'POST' || !/^\/v1\/images\/(generations|edits)$/.test(new URL(request.url).pathname)
				|| (probe.mode !== 'before-release' && probe.mode !== 'after-release'))) {
				return new Response('Invalid staging host expiry probe', { status: 400 });
			}
			if (probe.mode === 'before-fence' && !fencing) {
				return new Response('Staging fencing profile not configured', { status: 400 });
			}
			const aborting = probe.mode === 'before-abort' || probe.mode === 'after-abort';
			if (aborting && typeof context.abort !== 'function') {
				return new Response('Native staging abort unavailable', { status: 400 });
			}
			// Per-request facade: an exact tenant-owned armed row is still required.
			return handler.fetch(request, { ...bindings, DB: withImageStorageFault(bindings.DB, probe,
				{ polls, ...(aborting ? { abortContext: context } : {}), ...(waitUntilExpiry ? { waitUntilExpiry: true } : {}) }) }, context);
		},
	} satisfies ExportedHandler<ImagesStagingEnv>;
}
