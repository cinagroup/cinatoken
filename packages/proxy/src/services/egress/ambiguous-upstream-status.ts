import type { ProxyDispatchMeta } from '../failover-dispatch';

/** A status alone cannot prove that a dispatched POST or Upgrade did no work. */
export function ambiguousDispatchedStatusMeta(status: number): ProxyDispatchMeta | undefined {
	const mayHideAcceptedWork = (status >= 300 && status < 400)
		|| status === 408 || status === 499 || status >= 500;
	return mayHideAcceptedWork
		? { upstreamOutcomeUnknown: true, failoverForbidden: true }
		: undefined;
}
