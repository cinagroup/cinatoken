import {
	createRequestDeadline,
	preparationRead,
	RequestExecutionStoppedError,
	type GatewayRepositories,
} from "@octafuse/core";
import {
	isAudioModel,
	isImageGenerationModel,
	isRerankModel,
} from "@octafuse/core/db/model-modalities";
import { parseProviderEndpoints } from "@octafuse/core/provider-endpoints";
import { normalizeUpstreamProtocol } from "@octafuse/core/upstream-protocol";
import { parseGatewayToolId } from "@/lib/invoke-kind";
import {
	safePlaygroundUrl,
	safePlaygroundWireJson,
	safePlaygroundCustomParams,
} from "@/lib/playground/private-preview";
import {
	playgroundUploadLimits,
	PLAYGROUND_DASHSCOPE_SYNC_DATA_URL_MAX_BYTES,
	validatePlaygroundUploadType,
} from "@/lib/playground/uploads";
import {
	buildPlaygroundUpstreamRequest,
	type PlaygroundInvokeInput,
	type PlaygroundResolvedRoute,
} from "./playground-service";
import {
	listPlaygroundToolProviders,
	validatePlaygroundToolInput,
} from "./playground-tools-service";
import { AdminServiceError, badRequest, notFound } from "./errors";
import {
	playgroundStoppedError,
	PLAYGROUND_REQUEST_DEADLINE_MS,
} from "./playground-request-lifecycle";
import {
	PLAYGROUND_DASHSCOPE_REALTIME_OPERATIONS,
	preparePlaygroundRealtimeRequest,
	rewritePlaygroundRealtimeMessage,
	type PlaygroundDashScopeRealtimeOperation,
} from "./playground-realtime-service";

export type PlaygroundUploadDescription = {
	name: string;
	type: string;
	size: number;
};
export type PlaygroundUploadManifest = {
	images?: PlaygroundUploadDescription[];
	audio?: PlaygroundUploadDescription;
};
type PreviewInput = PlaygroundInvokeInput & {
	toolId?: string;
	provider?: string;
	uploadManifest?: unknown;
};
export type PlaygroundRequestPreview = {
	mode: "route" | "tool";
	upstream_url: string;
	request_body_json: string;
	preview_only: true;
	truncated: boolean;
	wire_format: "json" | "multipart" | "engine-envelope";
	ready: boolean;
	missing_upload?: "images" | "audio";
	uploads?: PlaygroundUploadManifest;
	credential_resolution: "execution-only";
	auth_resolution_deferred?: true;
};

function uploadDescription(value: unknown): PlaygroundUploadDescription {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw badRequest("Invalid upload manifest");
	const row = value as Record<string, unknown>;
	if (
		Object.keys(row).some((key) => !["name", "type", "size"].includes(key)) ||
		typeof row.name !== "string" ||
		!row.name ||
		row.name.length > 255 ||
		typeof row.type !== "string" ||
		row.type.length > 150 ||
		typeof row.size !== "number" ||
		!Number.isSafeInteger(row.size) ||
		row.size < 1
	)
		throw badRequest("Invalid upload manifest");
	return { name: row.name, type: row.type, size: row.size };
}

export function parsePlaygroundUploadManifest(
	value: unknown
): PlaygroundUploadManifest | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "object" || Array.isArray(value))
		throw badRequest("Invalid upload manifest");
	const row = value as Record<string, unknown>;
	if (Object.keys(row).some((key) => !["images", "audio"].includes(key)))
		throw badRequest("Invalid upload manifest");
	if (row.images !== undefined && !Array.isArray(row.images))
		throw badRequest("Invalid image upload manifest");
	const images = Array.isArray(row.images)
		? row.images.map(uploadDescription)
		: [];
	const audio =
		row.audio === undefined ? undefined : uploadDescription(row.audio);
	for (const image of images) validatePlaygroundUploadType("image", image);
	if (audio) validatePlaygroundUploadType("audio", audio);
	const limits = playgroundUploadLimits();
	if (
		(audio && images.length) ||
		images.length > limits.image_count ||
		images.some((image) => image.size > limits.image_file_bytes) ||
		images.reduce((sum, image) => sum + image.size, 0) >
			limits.image_total_bytes ||
		(audio && audio.size > limits.audio_file_bytes)
	)
		throw badRequest("Upload manifest exceeds Playground file limits");
	return { ...(images.length ? { images } : {}), ...(audio ? { audio } : {}) };
}

/** Preview uses only endpoint metadata. It never reveals/decrypts keys, exchanges OAuth, or fetches a provider. */
export async function previewPlaygroundRequest(
	repos: GatewayRepositories,
	input: PreviewInput,
	signal?: AbortSignal
): Promise<PlaygroundRequestPreview> {
	const owner = createRequestDeadline(
		Date.now() + PLAYGROUND_REQUEST_DEADLINE_MS,
		signal
	);
	try {
		owner.throwIfStopped();
		if (input.toolId) {
			const toolId = parseGatewayToolId(input.toolId);
			if (
				!toolId ||
				!listPlaygroundToolProviders(toolId).includes(input.provider ?? "")
			)
				throw badRequest("Invalid Playground tool provider");
			validatePlaygroundToolInput(toolId, input.body);
			const request_body_json = safePlaygroundWireJson(
				JSON.stringify({
					toolId,
					provider: input.provider,
					body: input.body,
					mode: "playground-direct-engine",
				})
			);
			return {
				mode: "tool" as const,
				credential_resolution: "execution-only",
				upstream_url: `engine://${toolId}/${input.provider}`,
				request_body_json,
				preview_only: true as const,
				wire_format: "engine-envelope" as const,
				ready: true,
				truncated: request_body_json.includes('"__playground_truncated":true'),
			};
		}
		const row = await preparationRead(owner, () =>
			repos.routes.getModelRouteRowById(input.routeId)
		);
		if (!row) throw notFound("Route not found");
		const [provider, model] = await Promise.all([
			preparationRead(owner, () =>
				repos.providers.getProviderProtocolBases(row.provider_id)
			),
			preparationRead(owner, () =>
				repos.models.getModelDetailWithRouteCounts(row.model_id)
			),
		]);
		if (!provider) throw badRequest("Provider not found for this route");
		let customParams: Record<string, unknown> | null = null;
		try {
			const value: unknown = row.custom_params
				? JSON.parse(row.custom_params)
				: null;
			if (
				value !== null &&
				(!value || typeof value !== "object" || Array.isArray(value))
			)
				throw new Error();
			customParams = value as Record<string, unknown> | null;
		} catch {
			throw badRequest("Invalid custom_params JSON on route");
		}
		const route: PlaygroundResolvedRoute = {
			upstreamProtocol: normalizeUpstreamProtocol(row.upstream_protocol),
			upstreamOperation: row.upstream_operation ?? "*",
			adapter: row.adapter ?? "passthrough",
			providerEndpoints: parseProviderEndpoints(provider),
			providerId: row.provider_id,
			providerApiKey: "[redacted]",
			providerModelName: row.provider_model_name,
			customParams: safePlaygroundCustomParams(customParams),
			isImageModel: !!model && isImageGenerationModel(model),
			isAudioModel: !!model && isAudioModel(model),
			isRerankModel: !!model && isRerankModel(model),
		};
		const uploads = parsePlaygroundUploadManifest(input.uploadManifest);
		if (
			(PLAYGROUND_DASHSCOPE_REALTIME_OPERATIONS as readonly string[]).includes(
				route.upstreamOperation
			)
		) {
			const operation =
				route.upstreamOperation as PlaygroundDashScopeRealtimeOperation;
			const url = preparePlaygroundRealtimeRequest(route, operation);
			const request_body_json = safePlaygroundWireJson(
				rewritePlaygroundRealtimeMessage(
					route,
					operation,
					JSON.stringify(input.body)
				)
			);
			return {
				mode: "route",
				credential_resolution: "execution-only",
				upstream_url: safePlaygroundUrl(url.toString()),
				request_body_json,
				preview_only: true,
				wire_format: "json",
				ready: true,
				uploads,
				truncated: request_body_json.includes('"__playground_truncated":true'),
			};
		}
		let missing_upload: "images" | "audio" | undefined;
		const imageOperation =
			input.imageOperation ??
			(route.upstreamOperation === "images.edits" ? "edits" : "generations");
		if (
			route.isImageModel &&
			imageOperation === "edits" &&
			!uploads?.images?.length &&
			!input.body.image &&
			!input.body.images
		)
			missing_upload = "images";
		if (
			route.isAudioModel &&
			(route.upstreamOperation === "audio.transcriptions" ||
				(route.upstreamOperation === "audio.transcriptions.multimodal" &&
					route.adapter !== "passthrough")) &&
			!uploads?.audio &&
			!input.body.file &&
			!input.body.audio
		)
			missing_upload = "audio";
		if (
			uploads?.audio &&
			route.upstreamProtocol === "dashscope" &&
			route.adapter !== "passthrough" &&
			4 * Math.ceil(uploads.audio.size / 3) +
				`data:${uploads.audio.type || "application/octet-stream"};base64,`
					.length >
				PLAYGROUND_DASHSCOPE_SYNC_DATA_URL_MAX_BYTES
		)
			throw badRequest(
				"DashScope synchronous ASR upload exceeds the 10 MiB encoded provider limit"
			);
		// The one-byte placeholder is used only to build representation metadata;
		// preview has no transport, and reports the supplied upload manifest separately.
		const prepared = await buildPlaygroundUpstreamRequest(
			route,
			{
				...input,
				uploads: {
					...(uploads?.images
						? {
								images: uploads.images.map(
									(image) =>
										new File([new Uint8Array(1)], image.name, {
											type: image.type,
										})
								),
						  }
						: missing_upload === "images"
						? {
								images: [
									new File([new Uint8Array(1)], "[select image].png", {
										type: "image/png",
									}),
								],
						  }
						: {}),
					...(uploads?.audio
						? {
								audio: new File([new Uint8Array(1)], uploads.audio.name, {
									type: uploads.audio.type,
								}),
						  }
						: missing_upload === "audio"
						? {
								audio: new File([new Uint8Array(1)], "[select audio].wav", {
									type: "audio/wav",
								}),
						  }
						: {}),
				},
			},
			owner
		);
		let wire = prepared.upstreamWireBodyJson;
		for (const upload of [
			...(uploads?.images ?? []),
			...(uploads?.audio ? [uploads.audio] : []),
		])
			wire = wire
				.split(`(1 bytes, ${upload.type})`)
				.join(`(${upload.size} bytes, ${upload.type})`);
		const request_body_json = safePlaygroundWireJson(wire);
		return {
			mode: "route" as const,
			credential_resolution: "execution-only",
			...(route.upstreamProtocol === "gemini" &&
			route.providerEndpoints.gemini?.auth !== "bearer"
				? { auth_resolution_deferred: true as const }
				: {}),
			upstream_url: safePlaygroundUrl(prepared.url),
			request_body_json,
			preview_only: true as const,
			uploads,
			wire_format:
				prepared.fetchBody instanceof FormData
					? ("multipart" as const)
					: ("json" as const),
			ready: !missing_upload,
			...(missing_upload ? { missing_upload } : {}),
			truncated:
				request_body_json.includes('"__playground_truncated":true') ||
				safePlaygroundUrl(prepared.url).includes("[truncated]"),
		};
	} catch (error) {
		if (owner.signal.reason instanceof RequestExecutionStoppedError)
			throw playgroundStoppedError(owner.signal.reason);
		if (error instanceof AdminServiceError) throw error;
		throw new AdminServiceError(502, "Playground request preview failed");
	} finally {
		owner.dispose();
	}
}
