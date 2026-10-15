import { peekResponseFirstEvent } from '../stream-first-event-timeout';
import type { ResourceCompletion } from '../resource-completion';
import { ownUpstreamResponse } from './owned-upstream-response';

/** A speculative first read must keep cleanup separate from financial settlement. */
export async function prepareTextStreamStart(
	response: Response,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<{ response: Response; timedOut: boolean; resourceCompletion?: ResourceCompletion }> {
	if (timeoutMs <= 0) return { response, timedOut: false };
	const owned = ownUpstreamResponse(response, signal);
	const peeked = await peekResponseFirstEvent(owned.response, timeoutMs, 'text stream');
	return { ...peeked, resourceCompletion: owned.resourceCompletion };
}

export function combineTextStreamResources(
	pump: ResourceCompletion,
	firstRead?: ResourceCompletion,
): ResourceCompletion {
	if (!firstRead) return pump;
	return Promise.all([pump, firstRead]).then(
		(results) => (results.every((value) => value === 'confirmed') ? 'confirmed' : 'unconfirmed'),
		() => 'unconfirmed',
	);
}
