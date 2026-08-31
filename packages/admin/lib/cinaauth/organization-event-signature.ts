const SIGNATURE_HEADER = 'x-cinaauth-signature';
const TIMESTAMP_HEADER = 'x-cinaauth-event-timestamp';
const SIGNATURE_VERSION = 'v1';

export const CINAUTH_EVENT_MAX_BODY_BYTES = 256 * 1024;
export const CINAUTH_EVENT_MAX_CLOCK_SKEW_SECONDS = 5 * 60;

const encoder = new TextEncoder();

const toHex = (bytes: Uint8Array): string =>
	Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
};

const fromHex = (value: string): Uint8Array | null => {
	if (!/^[a-f0-9]{64}$/u.test(value)) return null;
	const bytes = new Uint8Array(value.length / 2);
	for (let index = 0; index < value.length; index += 2) {
		bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
	}
	return bytes;
};

const importHmacKey = (secret: string, usage: KeyUsage[]): Promise<CryptoKey> =>
	crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		usage,
	);

const signingPayload = (timestamp: string, body: Uint8Array): Uint8Array => {
	const prefix = encoder.encode(`${timestamp}.`);
	const payload = new Uint8Array(prefix.length + body.length);
	payload.set(prefix);
	payload.set(body, prefix.length);
	return payload;
};

export async function sha256Hex(body: Uint8Array): Promise<string> {
	return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', toArrayBuffer(body))));
}

/** Producer helper shared by tests and the future CinaAuth event dispatcher. */
export async function signCinaAuthOrganizationEvent(
	body: Uint8Array,
	secret: string,
	timestamp: string,
): Promise<string> {
	const key = await importHmacKey(secret, ['sign']);
	const signature = await crypto.subtle.sign(
		'HMAC',
		key,
		toArrayBuffer(signingPayload(timestamp, body)),
	);
	return `${SIGNATURE_VERSION}=${toHex(new Uint8Array(signature))}`;
}

export type CinaAuthEventSignatureVerdict =
	| { ok: true; timestamp: string }
	| { ok: false; reason: 'missing_headers' | 'invalid_timestamp' | 'expired' | 'invalid_signature' };

/** Verify HMAC with Web Crypto; subtle.verify avoids a secret-dependent string comparison. */
export async function verifyCinaAuthOrganizationEventSignature(
	request: Request,
	body: Uint8Array,
	secret: string,
	nowMillis = Date.now(),
): Promise<CinaAuthEventSignatureVerdict> {
	const timestamp = request.headers.get(TIMESTAMP_HEADER)?.trim();
	const rawSignature = request.headers.get(SIGNATURE_HEADER)?.trim();
	if (!timestamp || !rawSignature) return { ok: false, reason: 'missing_headers' };
	if (!/^\d{10}$/u.test(timestamp)) return { ok: false, reason: 'invalid_timestamp' };
	const timestampSeconds = Number(timestamp);
	if (!Number.isSafeInteger(timestampSeconds)) return { ok: false, reason: 'invalid_timestamp' };
	if (Math.abs(Math.floor(nowMillis / 1000) - timestampSeconds) > CINAUTH_EVENT_MAX_CLOCK_SKEW_SECONDS) {
		return { ok: false, reason: 'expired' };
	}

	const [version, encodedSignature, ...extra] = rawSignature.split('=');
	if (version !== SIGNATURE_VERSION || extra.length > 0) {
		return { ok: false, reason: 'invalid_signature' };
	}
	const signature = fromHex(encodedSignature ?? '');
	if (!signature) return { ok: false, reason: 'invalid_signature' };
	const key = await importHmacKey(secret, ['verify']);
	const valid = await crypto.subtle.verify(
		'HMAC',
		key,
		toArrayBuffer(signature),
		toArrayBuffer(signingPayload(timestamp, body)),
	);
	return valid ? { ok: true, timestamp } : { ok: false, reason: 'invalid_signature' };
}

/** Read a streaming request body with a hard cap, including chunked requests. */
export async function readLimitedCinaAuthEventBody(
	request: Request,
	maxBytes = CINAUTH_EVENT_MAX_BODY_BYTES,
): Promise<Uint8Array> {
	const contentLength = request.headers.get('content-length');
	if (contentLength) {
		const declared = Number(contentLength);
		if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes) {
			throw new Error('event_body_too_large');
		}
	}
	if (!request.body) return new Uint8Array();

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > maxBytes) {
				await reader.cancel('event_body_too_large');
				throw new Error('event_body_too_large');
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const body = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}
