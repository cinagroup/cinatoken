import { RequestExecutionStoppedError } from '@octafuse/core';
export { createRequestDeadline, RequestExecutionStoppedError, type RequestDeadline, type DeadlineClock } from '@octafuse/core';

/** Local text execution ceiling; production SLOs still require C01/C02 acceptance. */
export const TEXT_REQUEST_DEADLINE_MS = 300_000;

/** Keep gateway timeouts distinct from a downstream cancellation in accounting. */
export function markTextStreamCancellation(
	usage: { cancelled?: boolean; stream_error?: string },
	signal?: AbortSignal,
): void {
	if (signal?.reason instanceof RequestExecutionStoppedError && signal.reason.reason === 'deadline_exceeded') {
		usage.stream_error ??= 'Request deadline exceeded';
	} else {
		usage.cancelled = true;
	}
}
