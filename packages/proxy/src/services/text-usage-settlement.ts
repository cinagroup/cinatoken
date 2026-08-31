import type { UsageFromStream } from './proxy';

export type TextUsageSafetyResult = {
	usage: UsageFromStream;
	incomplete: boolean;
	timedOut: boolean;
};

type SafetyTimer = {
	set(callback: () => void, timeoutMs: number): unknown;
	clear(handle: unknown): void;
};

const DEFAULT_SAFETY_TIMER: SafetyTimer = {
	set: (callback, timeoutMs) => setTimeout(callback, timeoutMs),
	clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** A parsed usage object is authoritative even when every counter is zero. */
export function hasAuthoritativeTextUsage(usage: UsageFromStream): boolean {
	return (typeof usage.raw_usage === 'string' && usage.raw_usage.length > 0)
		|| usage.total_tokens > 0
		|| usage.input_tokens > 0
		|| usage.output_tokens > 0
		|| usage.reasoning_tokens > 0;
}

/**
 * Text transports share one certainty decision for ordinary and Guardrail
 * settlement. Explicit non-2xx is known-zero unless an earlier/final network
 * attempt has an unknown outcome. Once 2xx headers arrive, missing/partial
 * usage is conservative and settles the reserved ceiling.
 */
export function textUsageCostIsUnknown(input: {
	upstreamResponseOk: boolean;
	usageAvailable: boolean;
	cancelled?: boolean;
	streamError?: boolean;
	upstreamOutcomeUnknown?: boolean;
	responseBodyTooLarge?: boolean;
}): boolean {
	if (input.upstreamOutcomeUnknown) return true;
	if (!input.upstreamResponseOk) return false;
	return !input.usageAvailable
		|| input.cancelled === true
		|| input.streamError === true
		|| input.responseBodyTooLarge === true;
}

/** Promise.race with deterministic loser-timer cleanup. */
export function textUsageWithSafetyTimeout(
	usagePromise: Promise<UsageFromStream>,
	timeoutMs: number,
	emptyUsage: UsageFromStream,
	timer: SafetyTimer = DEFAULT_SAFETY_TIMER,
): Promise<TextUsageSafetyResult> {
	let timeoutHandle: unknown;
	const timeout = new Promise<TextUsageSafetyResult>((resolve) => {
		timeoutHandle = timer.set(
			() => resolve({ usage: emptyUsage, incomplete: true, timedOut: true }),
			timeoutMs,
		);
	});
	return Promise.race([
		usagePromise.then((usage) => ({
			usage,
			incomplete: !hasAuthoritativeTextUsage(usage),
			timedOut: false,
		})),
		timeout,
	]).finally(() => {
		if (timeoutHandle !== undefined) timer.clear(timeoutHandle);
	});
}
