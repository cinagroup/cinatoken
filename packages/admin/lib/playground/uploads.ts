import { AUDIO_MAX_BYTES_PER_FILE } from "@/lib/audio-transcriptions";
import {
	IMAGE_MAX_BYTES_PER_FILE,
	IMAGE_MAX_REFERENCE_COUNT,
	IMAGE_MAX_TOTAL_UPLOAD_BYTES,
} from "@/lib/image-generations";
import { AdminServiceError, badRequest } from "@/lib/services/admin/errors";
import {
	createRequestDeadline,
	RequestExecutionStoppedError,
} from "@octafuse/core";
import {
	guardPlaygroundControlResponse,
	playgroundStoppedError,
	PLAYGROUND_REQUEST_DEADLINE_MS,
} from "@/lib/services/admin/playground-request-lifecycle";

export const PLAYGROUND_JSON_BODY_MAX_BYTES = 2 * 1024 * 1024;
export const PLAYGROUND_DASHSCOPE_SYNC_DATA_URL_MAX_BYTES = 10 * 1024 * 1024;
export type PlaygroundUploads = { images?: File[]; audio?: File };

/** Count actual bytes even when Content-Length is wrong, and own stalled uploads. */
export async function withBoundedPlaygroundBody<T>(
	request: Request,
	multipart: boolean,
	parse: (request: Request) => Promise<T>
): Promise<T> {
	const owner = createRequestDeadline(
		Date.now() + PLAYGROUND_REQUEST_DEADLINE_MS,
		request.signal
	);
	let bounded: Request | undefined;
	try {
		owner.throwIfStopped();
		const limit = multipart
			? playgroundUploadLimits().multipart_body_bytes
			: PLAYGROUND_JSON_BODY_MAX_BYTES;
		if (
			!request.headers.has("transfer-encoding") &&
			Number(request.headers.get("content-length")) > limit
		)
			throw new AdminServiceError(
				413,
				"Playground request body exceeds the limit"
			);
		if (!request.body) return await parse(request);
		let size = 0;
		const guarded = guardPlaygroundControlResponse(
			new Response(request.body),
			owner
		);
		const counted = guarded.body!.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					size += chunk.byteLength;
					if (size > limit)
						throw new AdminServiceError(
							413,
							"Playground request body exceeds the limit"
						);
					controller.enqueue(chunk);
				},
			})
		);
		bounded = new Request(request, {
			body: counted,
			signal: owner.signal,
			duplex: "half",
		} as RequestInit);
		return await owner.wait(() => parse(bounded!));
	} catch (error) {
		if (error instanceof RequestExecutionStoppedError)
			throw playgroundStoppedError(error);
		if (error instanceof Error && error.name === "BodyLimitError")
			throw new AdminServiceError(
				413,
				"Playground request body exceeds the limit"
			);
		throw error;
	} finally {
		void bounded?.body
			?.cancel("playground_body_parse_finished")
			.catch(() => undefined);
		owner.dispose();
	}
}

export function validatePlaygroundUploadType(
	kind: "image" | "audio",
	file: { name: string; type: string }
): void {
	if (!file.name || file.name.length > 255 || /[\p{Cc}\p{Cf}]/u.test(file.name))
		throw badRequest("Invalid upload filename");
	const image = /^image\/(?:png|jpe?g|webp|gif)$/iu.test(file.type);
	const audio =
		/^audio\/[a-z0-9.+-]+$/iu.test(file.type) ||
		["application/ogg", "video/mp4", "video/webm"].includes(file.type) ||
		((!file.type || file.type === "application/octet-stream") &&
			/\.(?:wav|mp3|mp4|m4a|webm|ogg|oga|opus|flac|aac|pcm|amr|aiff|aif)$/iu.test(
				file.name
			));
	if (kind === "image" ? !image : !audio)
		throw badRequest(`Unsupported ${kind} upload type`);
}

export function playgroundUploadLimits() {
	const cloudflare = typeof WebSocketPair !== "undefined";
	return {
		runtime: cloudflare ? ("cloudflare" as const) : ("node" as const),
		json_body_bytes: PLAYGROUND_JSON_BODY_MAX_BYTES,
		multipart_body_bytes: (cloudflare ? 36 : 104) * 1024 * 1024,
		image_file_bytes: IMAGE_MAX_BYTES_PER_FILE,
		image_count: IMAGE_MAX_REFERENCE_COUNT,
		image_total_bytes: cloudflare
			? 32 * 1024 * 1024
			: IMAGE_MAX_TOTAL_UPLOAD_BYTES,
		audio_file_bytes: AUDIO_MAX_BYTES_PER_FILE,
		dashscope_sync_data_url_bytes: PLAYGROUND_DASHSCOPE_SYNC_DATA_URL_MAX_BYTES,
	};
}

export function validatePlaygroundUploads(uploads: PlaygroundUploads): void {
	if (uploads.audio) validatePlaygroundUploadType("audio", uploads.audio);
	for (const file of uploads.images ?? [])
		validatePlaygroundUploadType("image", file);
	if (uploads.audio && uploads.images?.length)
		throw badRequest("Provide audio or reference images, not both");
	if (
		uploads.audio &&
		(uploads.audio.size === 0 || uploads.audio.size > AUDIO_MAX_BYTES_PER_FILE)
	)
		throw badRequest(
			`Audio file must contain between 1 and ${AUDIO_MAX_BYTES_PER_FILE} bytes`
		);
	const images = uploads.images ?? [];
	if (images.length > IMAGE_MAX_REFERENCE_COUNT)
		throw badRequest(
			`At most ${IMAGE_MAX_REFERENCE_COUNT} reference images are allowed`
		);
	if (
		images.some(
			(file) => file.size === 0 || file.size > IMAGE_MAX_BYTES_PER_FILE
		)
	)
		throw badRequest(
			`Each image must contain between 1 and ${IMAGE_MAX_BYTES_PER_FILE} bytes`
		);
	if (
		images.reduce((total, file) => total + file.size, 0) >
		playgroundUploadLimits().image_total_bytes
	)
		throw badRequest(
			`Total reference image bytes must be at most ${
				playgroundUploadLimits().image_total_bytes
			}`
		);
}

/** Multipart keeps uploads binary throughout the Admin and upstream request. */
export async function parsePlaygroundMultipart(
	request: Request
): Promise<{ envelope: Record<string, unknown>; uploads: PlaygroundUploads }> {
	const form = await request.formData();
	const allowed = new Set([
		"routeId",
		"body",
		"geminiAction",
		"imageOperation",
		"image",
		"file",
	]);
	for (const key of form.keys())
		if (!allowed.has(key))
			throw badRequest(`Unsupported Playground multipart field: ${key}`);
	for (const key of [
		"routeId",
		"body",
		"geminiAction",
		"imageOperation",
		"file",
	])
		if (form.getAll(key).length > 1)
			throw badRequest(`Duplicate Playground multipart field: ${key}`);
	const routeId = form.get("routeId");
	if (typeof routeId !== "string" || !routeId.trim())
		throw badRequest("routeId is required");
	const raw = form.get("body");
	if (
		typeof raw !== "string" ||
		new TextEncoder().encode(raw).byteLength > PLAYGROUND_JSON_BODY_MAX_BYTES
	)
		throw badRequest(
			"Multipart body must be JSON text within the JSON body limit"
		);
	let body: unknown;
	try {
		body = JSON.parse(raw) as unknown;
	} catch {
		throw badRequest("Invalid JSON body");
	}
	for (const key of ["geminiAction", "imageOperation"])
		if (form.has(key) && typeof form.get(key) !== "string")
			throw badRequest(`${key} must be text`);
	const images = form.getAll("image");
	if (images.some((value) => typeof value === "string"))
		throw badRequest("image must be a binary file");
	const audio = form.get("file");
	if (typeof audio === "string")
		throw badRequest("file must be a binary audio file");
	const uploads: PlaygroundUploads = {
		...(images.length ? { images: images as File[] } : {}),
		...(audio ? { audio } : {}),
	};
	validatePlaygroundUploads(uploads);
	return {
		envelope: {
			routeId,
			body,
			geminiAction: form.get("geminiAction") ?? undefined,
			imageOperation: form.get("imageOperation") ?? undefined,
		},
		uploads,
	};
}
