import { createResourceCompletionGroup, type ResourceCompletion } from '../resource-completion';

/** Buffered audio results finish usage before outstanding transport cleanup. */
export async function withBufferedAudioResources<T>(
	run: (track: (task: ResourceCompletion) => void) => Promise<T>,
): Promise<T & { resourceCompletion: ResourceCompletion }> {
	const resources = createResourceCompletionGroup();
	try {
		const result = await run(resources.track);
		return { ...result, resourceCompletion: resources.completion };
	} finally {
		resources.seal();
	}
}
