import { createResourceCompletionGroup, type ResourceCompletion } from '../resource-completion';
import { createOwnedJsonUploadBody } from './owned-json-upload-body';

/** Freeze the wire projection before auth/admission and combine both transport directions.
 * The callback must return the response body's owner even for non-2xx responses.
 */
export async function withOwnedJsonUpload<T extends { response: Response; resourceCompletion?: ResourceCompletion }>(
	value: Record<string, unknown>,
	signal: AbortSignal | undefined,
	run: (upload: ReturnType<typeof createOwnedJsonUploadBody>) => Promise<T>,
): Promise<T & { resourceCompletion: ResourceCompletion }> {
	const resources = createResourceCompletionGroup();
	const upload = createOwnedJsonUploadBody(value, signal ?? new AbortController().signal);
	resources.track(upload.resourceCompletion);
	try {
		const result = await run(upload);
		if (result.resourceCompletion) resources.track(result.resourceCompletion);
		return { ...result, resourceCompletion: resources.completion };
	} finally {
		// Response headers do not prove the transport consumed the upload to EOF.
		upload.stop();
		resources.seal();
	}
}
