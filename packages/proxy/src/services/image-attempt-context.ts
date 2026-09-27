import { createHash } from 'node:crypto';
import { resolveUpstreamEndpoint } from '@octafuse/core';
import { MAX_REQUEST_BODY_BYTES } from './bounded-request-body';
import { streamJsonBody } from './egress/stream-json-body';
import { IMAGE_JSON_STRUCTURE_LIMITS } from './json-structure-budget';
import type { RouteResult } from './model-router';
import type { RequestDeadline } from './request-deadline';
import { buildRouteRequestBody } from './route-default-params';
import { MultipartFile } from './streaming-multipart-body';
import type { ImageEditUpload, NormalizedImageEditRequest } from './egress/openai-images-driver';

const CONTEXT_DOMAIN = 'cinatoken.images.attempt-context.v1\n';
const GENERATION_PAYLOAD_DOMAIN = 'cinatoken.images.generation-egress.v1\n';
const EDIT_PAYLOAD_DOMAIN = 'cinatoken.images.edit-egress.v1\n';
const MAX_DIGEST_JSON_BYTES = 4 * MAX_REQUEST_BODY_BYTES;
const MAX_FILES = 5;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const ALLOWED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);
const HEX_SHA256 = /^[a-f0-9]{64}$/;
const normalizeFormLines = (value: string) => value.replace(/\r\n|\r|\n/g, '\r\n');
const JSON_LIMITS = Object.freeze({
	maxDepth: IMAGE_JSON_STRUCTURE_LIMITS.maxDepth + 4,
	maxNodes: IMAGE_JSON_STRUCTURE_LIMITS.maxNodes + 128,
});

export type ImageAttemptContextControl = Pick<RequestDeadline, 'signal' | 'throwIfStopped'>;

/** This is also the generations driver's complete pre-serialization body projection. */
export function buildImageGenerationUpstreamBody(
	route: RouteResult,
	body: Record<string, unknown>,
): Record<string, unknown> {
	return { ...buildRouteRequestBody(route, body), model: route.providerModelName };
}

/**
 * The edits driver appends these scalar fields, in order, before its image
 * parts. Object/array defaults and model/image/images overrides are ignored.
 */
export function buildImageEditUpstreamFields(
	route: RouteResult,
	edit: NormalizedImageEditRequest,
): Array<readonly [string, string]> {
	const merged = buildRouteRequestBody(route, {
		...(edit.extra ?? {}),
		prompt: edit.prompt,
		n: edit.n,
		...(edit.size ? { size: edit.size } : {}),
		...(edit.quality ? { quality: edit.quality } : {}),
		...(edit.background ? { background: edit.background } : {}),
	});
	const fields: Array<readonly [string, string]> = [['model', normalizeFormLines(route.providerModelName)]];
	for (const [key, value] of Object.entries(merged)) {
		if (value == null || key === 'model' || key === 'image' || key === 'images') continue;
		if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
			fields.push([normalizeFormLines(key), normalizeFormLines(String(value))]);
		}
	}
	return fields;
}

/** Metadata as the paged multipart writer places it on the wire. */
export function imageEditUpstreamFileMetadata(image: ImageEditUpload): { filename: string; mimeType: string } {
	return {
		filename: image.filename || 'image.png',
		mimeType: new Blob([], { type: image.mimeType }).type || 'application/octet-stream',
	};
}

async function hashJson(value: unknown, domain: string, control: ImageAttemptContextControl): Promise<string> {
	control.throwIfStopped();
	const hash = createHash('sha256').update(domain);
	const stream = streamJsonBody(value, JSON_LIMITS, {
		signal: control.signal,
		checkActive: control.throwIfStopped,
	});
	const reader = stream.getReader();
	let bytes = 0;
	try {
		while (true) {
			control.throwIfStopped();
			const part = await reader.read();
			control.throwIfStopped();
			if (part.done) break;
			bytes += part.value.byteLength;
			if (bytes > MAX_DIGEST_JSON_BYTES) throw new RangeError('Image attempt JSON exceeds its byte limit');
			hash.update(part.value);
		}
		control.throwIfStopped();
		return hash.digest('hex');
	} finally {
		void reader.cancel('image_attempt_digest_finished').catch(() => undefined);
		reader.releaseLock();
	}
}

async function hashFile(file: MultipartFile, control: ImageAttemptContextControl): Promise<string> {
	control.throwIfStopped();
	if (file.size < 1 || file.size > MAX_FILE_BYTES) throw new RangeError('Invalid image attempt file size');
	const hash = createHash('sha256');
	const reader = file.stream().getReader();
	let bytes = 0;
	try {
		while (true) {
			control.throwIfStopped();
			const part = await reader.read();
			control.throwIfStopped();
			if (part.done) break;
			bytes += part.value.byteLength;
			if (bytes > file.size || bytes > MAX_FILE_BYTES) throw new RangeError('Image attempt file exceeds its admitted size');
			hash.update(part.value);
		}
		if (bytes !== file.size) throw new RangeError('Image attempt file size changed');
		control.throwIfStopped();
		return hash.digest('hex');
	} finally {
		void reader.cancel('image_attempt_digest_finished').catch(() => undefined);
		reader.releaseLock();
	}
}

function routeFacts(route: RouteResult, operation: 'images.generations' | 'images.edits', preparedUrl?: string) {
	if (route.upstreamProtocol !== 'openai') throw new TypeError('Image attempt requires an OpenAI route');
	const url = preparedUrl ?? resolveUpstreamEndpoint('openai', operation, route.providerEndpoints, { providerId: route.providerId });
	const parsed = new URL(url);
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new TypeError('Image attempt requires an HTTP(S) upstream');
	const facts = {
		targetId: route.targetId,
		providerId: route.providerId,
		endpointId: route.endpoint?.id ?? null,
		providerKeyId: route.providerKeyId ?? null,
		providerKeyFingerprint: route.providerKeyFingerprint ?? null,
		providerModelName: route.providerModelName,
		modelSurfaceId: route.modelSurfaceId,
		routePoolId: route.routePoolId,
		gatewayModelId: route.gatewayModelId ?? null,
		upstreamProtocol: route.upstreamProtocol,
		upstreamOperation: route.upstreamOperation,
		upstreamUrl: url,
	};
	for (const value of Object.values(facts)) {
		if (value !== null && (typeof value !== 'string' || value.length > 16_384)) {
			throw new TypeError('Invalid image attempt route identity');
		}
	}
	if (!facts.targetId || !facts.providerId || !facts.providerModelName) {
		throw new TypeError('Incomplete image attempt route identity');
	}
	return facts;
}

export type ImageAttemptRouteFacts = Readonly<ReturnType<typeof routeFacts>>;
export type ImageAttemptRouteIdentity = Readonly<Omit<ImageAttemptRouteFacts, 'upstreamUrl'> & {
	upstreamUrlSha256: string;
}>;

function safeRouteIdentity(facts: ImageAttemptRouteFacts): ImageAttemptRouteIdentity {
	const { upstreamUrl, ...safeFacts } = facts;
	return Object.freeze({
		...safeFacts,
		upstreamUrlSha256: createHash('sha256').update(upstreamUrl).digest('hex'),
	});
}

/** Capture the selected driver's URL and non-secret route identity before any asynchronous preparation. */
export function captureImageAttemptRouteFacts(
	route: RouteResult, operation: 'images.generations' | 'images.edits', upstreamUrl: string,
): ImageAttemptRouteFacts {
	return Object.freeze(routeFacts(route, operation, upstreamUrl));
}

export type PreparedImageAttempt = Readonly<{
	operation: 'images.generations' | 'images.edits';
	routeIdentity: ImageAttemptRouteIdentity;
	/** Binds the trusted ingress digest to the exact private payload projection the driver will fetch. */
	digestTrustedContext: (
		requestSha256: string, control: ImageAttemptContextControl,
	) => Promise<{ contextSha256: string; outboundPayloadSha256: string }>;
}>;

/** Compare every selected route fact, including the resolved URL fingerprint, before claim. */
export function preparedImageAttemptMatchesRoute(prepared: PreparedImageAttempt, route: RouteResult): boolean {
	try {
		const expected = safeRouteIdentity(routeFacts(route, prepared.operation));
		const observed = prepared.routeIdentity;
		return (Object.keys(expected) as Array<keyof ImageAttemptRouteIdentity>)
			.every(key => observed[key] === expected[key]);
	} catch { return false; }
}

function preparedAttempt(
	operation: PreparedImageAttempt['operation'], facts: ImageAttemptRouteFacts,
	digestPayload: (control: ImageAttemptContextControl) => Promise<string>,
): PreparedImageAttempt {
	const capturedFacts = Object.freeze({ ...facts });
	const routeIdentity = safeRouteIdentity(capturedFacts);
	return Object.freeze({
		operation, routeIdentity,
		async digestTrustedContext(requestSha256: string, control: ImageAttemptContextControl) {
			control.throwIfStopped();
			if (!HEX_SHA256.test(requestSha256)) throw new TypeError('Invalid trusted image request digest');
			const outboundPayloadSha256 = await digestPayload(control);
			const contextSha256 = await hashJson({
				operation, requestSha256, route: capturedFacts, outboundPayloadSha256,
			}, CONTEXT_DOMAIN, control);
			return { contextSha256, outboundPayloadSha256 };
		},
	});
}

/** The snapshot is created by createJsonUploadBody and is also owned by its wire stream. */
export function createPreparedImageGenerationAttempt(
	facts: ImageAttemptRouteFacts, preparedUploadSnapshot: unknown,
): PreparedImageAttempt {
	return preparedAttempt('images.generations', facts,
		control => hashJson(preparedUploadSnapshot, GENERATION_PAYLOAD_DOMAIN, control));
}

export type PreparedImageEditFile = Readonly<{
	filename: string;
	mimeType: string;
	payload: MultipartFile | Blob;
}>;

/** The same scalar values and file handles are handed to createMultipartUploadBody. */
export function createPreparedImageEditAttempt(
	facts: ImageAttemptRouteFacts,
	fields: ReadonlyArray<readonly [string, string]>,
	files: ReadonlyArray<PreparedImageEditFile>,
): PreparedImageAttempt {
	const scalars = fields.map(([key, value]) => [key, value] as const);
	const images = files.map(file => ({
		filename: file.filename || 'image.png',
		mimeType: new Blob([], { type: file.mimeType }).type || 'application/octet-stream',
		payload: file.payload,
		size: file.payload.size,
	}));
	return preparedAttempt('images.edits', facts, async control => {
		if (images.length < 1 || images.length > MAX_FILES) throw new RangeError('Invalid image attempt file count');
		let totalBytes = 0;
		const digestedImages: Array<{ filename: string; mimeType: string; size: number; sha256: string }> = [];
		for (const image of images) {
			control.throwIfStopped();
			// Public multipart parsing produces exact MultipartFile instances with
			// private, sealed pages. A subclass/overridden stream could return new
			// bytes for the later transport pull and is not grant eligible.
			if (!(image.payload instanceof MultipartFile)
				|| Object.getPrototypeOf(image.payload) !== MultipartFile.prototype
				|| Object.hasOwn(image.payload, 'stream')
				|| !ALLOWED_IMAGE_MIME.has(image.mimeType)
				|| image.filename.length > 16_384) {
				throw new TypeError('Image attempt requires an admitted multipart file');
			}
			if (image.payload.size !== image.size) throw new RangeError('Image attempt file size changed');
			totalBytes += image.size;
			if (totalBytes > MAX_REQUEST_BODY_BYTES) throw new RangeError('Image attempt files exceed ingress limit');
			digestedImages.push({
				filename: image.filename, mimeType: image.mimeType, size: image.size,
				sha256: await hashFile(image.payload, control),
			});
		}
		return hashJson({ fields: scalars, images: digestedImages }, EDIT_PAYLOAD_DOMAIN, control);
	});
}

export type TrustedImageAttemptContextInput = {
	requestSha256: string;
	route: RouteResult;
	control: ImageAttemptContextControl;
} & (
	| { operation: 'images.generations'; body: Record<string, unknown>; edit?: never }
	| { operation: 'images.edits'; edit: NormalizedImageEditRequest; body?: never }
);

/**
 * Comparison helper for callers that own stable inputs. It recomputes the
 * projection, so a financial grant must instead use the driver's
 * PreparedImageAttempt at its pre-fetch boundary. Multipart's random boundary
 * is transport framing and is deliberately outside the edits payload digest.
 */
export async function digestTrustedImageAttemptContext(input: TrustedImageAttemptContextInput): Promise<{
	contextSha256: string;
	outboundPayloadSha256: string;
}> {
	const { operation, requestSha256, route, control } = input;
	control.throwIfStopped();
	if (!HEX_SHA256.test(requestSha256)) throw new TypeError('Invalid trusted image request digest');
	const identity = routeFacts(route, operation);
	let outboundPayloadSha256: string;
	if (operation === 'images.generations') {
		outboundPayloadSha256 = await hashJson(
			buildImageGenerationUpstreamBody(route, input.body), GENERATION_PAYLOAD_DOMAIN, control,
		);
	} else {
		const { edit } = input;
		if (edit.images.length < 1 || edit.images.length > MAX_FILES) throw new RangeError('Invalid image attempt file count');
		let totalBytes = 0;
		const images: Array<{ filename: string; mimeType: string; size: number; sha256: string }> = [];
		for (const image of edit.images) {
			control.throwIfStopped();
			if (!(image.upload instanceof MultipartFile)
				|| typeof image.filename !== 'string' || image.filename.length > 16_384
				|| typeof image.mimeType !== 'string' || !ALLOWED_IMAGE_MIME.has(image.mimeType.trim().toLowerCase())) {
				throw new TypeError('Image attempt requires an admitted multipart file');
			}
			totalBytes += image.upload.size;
			if (totalBytes > MAX_REQUEST_BODY_BYTES) throw new RangeError('Image attempt files exceed ingress limit');
			images.push({ ...imageEditUpstreamFileMetadata(image),
				size: image.upload.size, sha256: await hashFile(image.upload, control) });
		}
		outboundPayloadSha256 = await hashJson({
			fields: buildImageEditUpstreamFields(route, edit),
			images,
		}, EDIT_PAYLOAD_DOMAIN, control);
	}
	const contextSha256 = await hashJson({
		operation, requestSha256, route: identity, outboundPayloadSha256,
	}, CONTEXT_DOMAIN, control);
	return { contextSha256, outboundPayloadSha256 };
}
