import { createHash } from 'node:crypto';
import { MAX_REQUEST_BODY_BYTES } from './bounded-request-body';
import { IMAGE_JSON_STRUCTURE_LIMITS } from './json-structure-budget';
import { streamJsonBody } from './egress/stream-json-body';
import {
	IMAGE_MAX_BYTES_PER_FILE,
	IMAGE_MAX_REFERENCE_COUNT,
	validateImageUpload,
	type NormalizedImageEditRequest,
} from './egress/openai-images-driver';
import type { RequestDeadline } from './request-deadline';
import { MultipartFile } from './streaming-multipart-body';

const DOMAIN = 'cinatoken.images.trusted-ingress.v1\n';
// JSON parsing admits at most 50 MiB of wire bytes. Replacement characters
// and canonical escaping can expand the re-encoded representation; this cap
// bounds direct/helper misuse without retaining that representation.
const MAX_DIGEST_JSON_BYTES = 4 * MAX_REQUEST_BODY_BYTES;
const DIGEST_JSON_LIMITS = Object.freeze({
	maxDepth: IMAGE_JSON_STRUCTURE_LIMITS.maxDepth + 3,
	maxNodes: IMAGE_JSON_STRUCTURE_LIMITS.maxNodes + 32,
});

export type ImageRequestDigestControl = Pick<RequestDeadline, 'signal' | 'throwIfStopped'>;

/**
 * SHA-256 of a versioned, deterministic JSON encoding of trusted, parsed
 * ingress facts. The encoder and hash consume <=64 KiB pages; large Images
 * strings remain paged. This is deliberately separate from route-specific
 * context_sha256 and does not accept a client-supplied digest.
 */
async function digestJson(value: Record<string, unknown>, control: ImageRequestDigestControl): Promise<string> {
	control.throwIfStopped();
	const hash = createHash('sha256').update(DOMAIN);
	const stream = streamJsonBody(value, DIGEST_JSON_LIMITS, {
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
			if (bytes > MAX_DIGEST_JSON_BYTES) throw new RangeError('Image digest JSON exceeds its byte limit');
			hash.update(part.value);
		}
		control.throwIfStopped();
		return hash.digest('hex');
	} catch (error) {
		control.throwIfStopped();
		throw error;
	} finally {
		void reader.cancel('image_digest_finished').catch(() => undefined);
		reader.releaseLock();
	}
}

/** Call immediately after successful JSON ingress validation, before mutation. */
export function digestTrustedImageGenerationIngress(input: {
	body: Record<string, unknown>;
	sessionId: string | null;
	control: ImageRequestDigestControl;
}): Promise<string> {
	return digestJson({
		operation: 'images.generations',
		sessionId: input.sessionId,
		body: input.body,
	}, input.control);
}

async function digestParsedFile(file: MultipartFile, control: ImageRequestDigestControl): Promise<string> {
	control.throwIfStopped();
	if (file.size < 1 || file.size > IMAGE_MAX_BYTES_PER_FILE) throw new RangeError('Invalid image digest file size');
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
			if (bytes > file.size || bytes > IMAGE_MAX_BYTES_PER_FILE) throw new RangeError('Image digest file exceeds its admitted size');
			hash.update(part.value);
		}
		if (bytes !== file.size) throw new RangeError('Image digest file size changed');
		control.throwIfStopped();
		return hash.digest('hex');
	} finally {
		void reader.cancel('image_digest_finished').catch(() => undefined);
		reader.releaseLock();
	}
}

/**
 * Hash the accepted edit fields and actual decoded file bytes, in upload
 * order. Only the successful multipart parser's replayable MultipartFile is
 * supported; Blob/Uint8Array callers fail closed until separately admitted.
 * Ignored multipart fields and framing do not affect the upstream request.
 */
export async function digestTrustedImageEditIngress(input: {
	model: string;
	provider: Record<string, unknown> | null;
	edit: NormalizedImageEditRequest;
	sessionId: string | null;
	control: ImageRequestDigestControl;
}): Promise<string> {
	const { edit, control } = input;
	control.throwIfStopped();
	if (edit.images.length < 1 || edit.images.length > IMAGE_MAX_REFERENCE_COUNT) {
		throw new RangeError('Invalid image digest reference count');
	}
	let totalBytes = 0;
	const images: Array<{ filename: string; mimeType: string; size: number; sha256: string }> = [];
	for (const image of edit.images) {
		control.throwIfStopped();
		if (!(image.upload instanceof MultipartFile) || validateImageUpload(image)) {
			throw new TypeError('Image digest requires an admitted multipart file');
		}
		totalBytes += image.upload.size;
		if (totalBytes > MAX_REQUEST_BODY_BYTES) throw new RangeError('Image digest upload exceeds ingress limit');
		images.push({
			filename: image.filename,
			mimeType: image.mimeType,
			size: image.upload.size,
			sha256: await digestParsedFile(image.upload, control),
		});
	}
	return digestJson({
		operation: 'images.edits',
		sessionId: input.sessionId,
		model: input.model,
		provider: input.provider,
		prompt: edit.prompt,
		n: edit.n,
		size: edit.size ?? null,
		quality: edit.quality ?? null,
		background: edit.background ?? null,
		extra: edit.extra ?? null,
		images,
	}, control);
}
