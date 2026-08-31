/**
 * Bounded OpenRouter STT JSON reader.
 *
 * `input_audio.data` is decoded while the request stream is read and is replaced
 * with a sentinel in the small JSON metadata document. This avoids retaining a
 * 33 MiB base64 string alongside the decoded 25 MiB upload in a Worker isolate.
 */

export const OPENROUTER_AUDIO_JSON_MAX_DECODED_BYTES = 25 * 1024 * 1024;
export const OPENROUTER_AUDIO_JSON_MAX_METADATA_BYTES = 256 * 1024;
export const OPENROUTER_AUDIO_JSON_MAX_REQUEST_BYTES =
	Math.ceil(OPENROUTER_AUDIO_JSON_MAX_DECODED_BYTES / 3) * 4
	+ OPENROUTER_AUDIO_JSON_MAX_METADATA_BYTES;

const AUDIO_DATA_SENTINEL = '__cinatoken_openrouter_audio_data__';
const BASE64_FLUSH_CHARS = 64 * 1024;

export type OpenRouterAudioJsonFailureKind =
	| 'invalid_json'
	| 'invalid_request'
	| 'payload_too_large'
	| 'cancelled';

export class OpenRouterAudioJsonError extends Error {
	constructor(
		readonly kind: OpenRouterAudioJsonFailureKind,
		message: string,
	) {
		super(message);
		this.name = 'OpenRouterAudioJsonError';
	}
}

export type OpenRouterAudioJsonResult = {
	body: Record<string, unknown>;
	audioBytes: Uint8Array;
};

export type OpenRouterAudioJsonLimits = {
	maxDecodedBytes?: number;
	maxMetadataBytes?: number;
	maxRequestBytes?: number;
};

function boundedPositiveInteger(value: number | undefined, fallback: number): number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
		? Math.min(value, fallback)
		: fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

class BoundedBase64Decoder {
	private pending = '';
	private encodedChars = 0;
	private output = new Uint8Array(64 * 1024);
	private outputLength = 0;
	private paddingStarted = false;
	private paddingChars = 0;

	constructor(private readonly maxDecodedBytes: number) {}

	push(value: string): void {
		if (!value) return;
		this.encodedChars += value.length;
		const maxEncodedChars = Math.ceil(this.maxDecodedBytes / 3) * 4;
		if (this.encodedChars > maxEncodedChars) {
			throw new OpenRouterAudioJsonError(
				'payload_too_large',
				`input_audio.data decodes to more than ${this.maxDecodedBytes} bytes`,
			);
		}

		if (this.paddingStarted) {
			if (!/^=+$/.test(value)) {
				throw new OpenRouterAudioJsonError('invalid_request', 'input_audio.data is not valid base64');
			}
			this.paddingChars += value.length;
			if (this.paddingChars > 2) {
				throw new OpenRouterAudioJsonError('invalid_request', 'input_audio.data is not valid base64');
			}
			this.pending += value;
			return;
		}

		const paddingIndex = value.indexOf('=');
		const unpadded = paddingIndex < 0 ? value : value.slice(0, paddingIndex);
		if (unpadded && !/^[A-Za-z0-9+/]+$/.test(unpadded)) {
			throw new OpenRouterAudioJsonError('invalid_request', 'input_audio.data is not valid base64');
		}
		this.pending += unpadded;
		if (paddingIndex >= 0) {
			const padding = value.slice(paddingIndex);
			if (!/^=+$/.test(padding) || padding.length > 2) {
				throw new OpenRouterAudioJsonError('invalid_request', 'input_audio.data is not valid base64');
			}
			this.paddingStarted = true;
			this.paddingChars = padding.length;
			this.pending += padding;
			return;
		}

		if (this.pending.length >= BASE64_FLUSH_CHARS) {
			const flushLength = this.pending.length - (this.pending.length % 4);
			if (flushLength > 0) {
				this.decodeQuartets(this.pending.slice(0, flushLength));
				this.pending = this.pending.slice(flushLength);
			}
		}
	}

	finish(): Uint8Array {
		if (this.encodedChars === 0) {
			throw new OpenRouterAudioJsonError('invalid_request', 'input_audio.data must not be empty');
		}
		if (this.paddingStarted) {
			if (this.pending.length % 4 !== 0) {
				throw new OpenRouterAudioJsonError('invalid_request', 'input_audio.data is not valid base64');
			}
		} else {
			const remainder = this.pending.length % 4;
			if (remainder === 1) {
				throw new OpenRouterAudioJsonError('invalid_request', 'input_audio.data is not valid base64');
			}
			if (remainder > 0) this.pending += '='.repeat(4 - remainder);
		}
		this.decodeQuartets(this.pending);
		this.pending = '';
		return this.output.subarray(0, this.outputLength);
	}

	private decodeQuartets(value: string): void {
		if (!value) return;
		let binary: string;
		try {
			binary = atob(value);
		} catch {
			throw new OpenRouterAudioJsonError('invalid_request', 'input_audio.data is not valid base64');
		}
		const required = this.outputLength + binary.length;
		if (required > this.maxDecodedBytes) {
			throw new OpenRouterAudioJsonError(
				'payload_too_large',
				`input_audio.data decodes to more than ${this.maxDecodedBytes} bytes`,
			);
		}
		this.ensureCapacity(required);
		for (let index = 0; index < binary.length; index += 1) {
			this.output[this.outputLength + index] = binary.charCodeAt(index);
		}
		this.outputLength = required;
	}

	private ensureCapacity(required: number): void {
		if (required <= this.output.byteLength) return;
		let nextLength = this.output.byteLength;
		while (nextLength < required) {
			nextLength = Math.min(this.maxDecodedBytes, nextLength * 2);
			if (nextLength < required && nextLength === this.maxDecodedBytes) {
				throw new OpenRouterAudioJsonError('payload_too_large', 'input_audio.data is too large');
			}
		}
		const next = new Uint8Array(nextLength);
		next.set(this.output.subarray(0, this.outputLength));
		this.output = next;
	}
}

type ObjectFrame = {
	kind: 'object';
	path: string[];
	state: 'key_or_end' | 'colon' | 'value' | 'comma_or_end';
	key: string | null;
};

type ArrayFrame = {
	kind: 'array';
	path: string[];
	state: 'value_or_end' | 'comma_or_end';
};

type JsonFrame = ObjectFrame | ArrayFrame;
type StringRole = 'key' | 'value' | 'audio_data';

class StreamingAudioJsonExtractor {
	private readonly frames: JsonFrame[] = [];
	private readonly sanitizedParts: string[] = [];
	private sanitizedUtf8Bytes = 0;
	private pendingHighSurrogate = false;
	private rootState: 'value' | 'done' = 'value';
	private inString = false;
	private stringRole: StringRole = 'value';
	private stringEscaped = false;
	private keyRaw = '';
	private inPrimitive = false;
	private audioDataCount = 0;

	constructor(
		private readonly base64: BoundedBase64Decoder,
		private readonly maxMetadataBytes: number,
	) {}

	push(text: string): void {
		let index = 0;
		while (index < text.length) {
			if (this.inString) {
				if (this.stringRole === 'audio_data') {
					const quoteIndex = text.indexOf('"', index);
					const escapeIndex = text.indexOf('\\', index);
					const nextSpecial = quoteIndex < 0
						? escapeIndex
						: escapeIndex < 0
							? quoteIndex
							: Math.min(quoteIndex, escapeIndex);
					const end = nextSpecial < 0 ? text.length : nextSpecial;
					this.base64.push(text.slice(index, end));
					index = end;
					if (index >= text.length) break;
					if (text[index] === '\\') {
						throw new OpenRouterAudioJsonError(
							'invalid_request',
							'input_audio.data must be raw base64 without JSON escapes',
						);
					}
					this.inString = false;
					this.completeValue();
					index += 1;
					continue;
				}

				const character = text[index]!;
				this.appendSanitized(character);
				if (this.stringRole === 'key') this.keyRaw += character;
				if (this.stringEscaped) {
					this.stringEscaped = false;
				} else if (character === '\\') {
					this.stringEscaped = true;
				} else if (character === '"') {
					this.inString = false;
					if (this.stringRole === 'key') this.completeKey();
					else this.completeValue();
				}
				index += 1;
				continue;
			}

			const character = text[index]!;
			if (this.inPrimitive) {
				if (character !== ',' && character !== '}' && character !== ']') {
					this.appendSanitized(character);
					index += 1;
					continue;
				}
				this.inPrimitive = false;
				this.completeValue();
				continue;
			}

			if (/\s/.test(character)) {
				this.appendSanitized(character);
				index += 1;
				continue;
			}
			if (character === '"') {
				this.beginString();
				index += 1;
				continue;
			}
			if (character === '{' || character === '[') {
				this.beginContainer(character);
				this.appendSanitized(character);
				index += 1;
				continue;
			}
			if (character === '}' || character === ']') {
				this.endContainer(character);
				this.appendSanitized(character);
				index += 1;
				continue;
			}
			if (character === ':') {
				const frame = this.frames[this.frames.length - 1];
				if (frame?.kind === 'object' && frame.state === 'colon') frame.state = 'value';
				this.appendSanitized(character);
				index += 1;
				continue;
			}
			if (character === ',') {
				const frame = this.frames[this.frames.length - 1];
				if (frame?.kind === 'object' && frame.state === 'comma_or_end') {
					frame.state = 'key_or_end';
					frame.key = null;
				} else if (frame?.kind === 'array' && frame.state === 'comma_or_end') {
					frame.state = 'value_or_end';
				}
				this.appendSanitized(character);
				index += 1;
				continue;
			}

			this.beginPrimitive();
			this.appendSanitized(character);
			index += 1;
		}
	}

	finish(): OpenRouterAudioJsonResult {
		if (this.inString || this.inPrimitive || this.frames.length !== 0 || this.rootState !== 'done') {
			throw new OpenRouterAudioJsonError('invalid_json', 'Invalid JSON body');
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(this.sanitizedParts.join('')) as unknown;
		} catch {
			throw new OpenRouterAudioJsonError('invalid_json', 'Invalid JSON body');
		}
		if (!isRecord(parsed)) {
			throw new OpenRouterAudioJsonError('invalid_request', 'JSON body must be an object');
		}
		const inputAudio = isRecord(parsed.input_audio) ? parsed.input_audio : null;
		if (
			this.audioDataCount !== 1
			|| inputAudio == null
			|| inputAudio.data !== AUDIO_DATA_SENTINEL
		) {
			throw new OpenRouterAudioJsonError(
				'invalid_request',
				'input_audio.data must be a single base64 string',
			);
		}
		const audioBytes = this.base64.finish();
		const body = {
			...parsed,
			input_audio: { ...inputAudio },
		};
		delete (body.input_audio as Record<string, unknown>).data;
		return { body, audioBytes };
	}

	private beginString(): void {
		const frame = this.frames[this.frames.length - 1];
		if (frame?.kind === 'object' && frame.state === 'key_or_end') {
			this.stringRole = 'key';
			this.keyRaw = '"';
			this.appendSanitized('"');
		} else {
			const path = this.valuePath();
			const audioData = path.length === 2 && path[0] === 'input_audio' && path[1] === 'data';
			this.stringRole = audioData ? 'audio_data' : 'value';
			if (audioData) {
				this.audioDataCount += 1;
				if (this.audioDataCount > 1) {
					throw new OpenRouterAudioJsonError(
						'invalid_request',
						'input_audio.data must appear exactly once',
					);
				}
				this.appendSanitized(JSON.stringify(AUDIO_DATA_SENTINEL));
			} else {
				this.appendSanitized('"');
			}
		}
		this.inString = true;
		this.stringEscaped = false;
	}

	private completeKey(): void {
		const frame = this.frames[this.frames.length - 1];
		if (frame?.kind !== 'object') return;
		let key: unknown;
		try {
			key = JSON.parse(this.keyRaw) as unknown;
		} catch {
			throw new OpenRouterAudioJsonError('invalid_json', 'Invalid JSON body');
		}
		frame.key = typeof key === 'string' ? key : null;
		frame.state = 'colon';
		this.keyRaw = '';
	}

	private beginPrimitive(): void {
		this.inPrimitive = true;
	}

	private beginContainer(character: '{' | '['): void {
		const path = this.valuePath();
		this.frames.push(character === '{'
			? { kind: 'object', path, state: 'key_or_end', key: null }
			: { kind: 'array', path, state: 'value_or_end' });
	}

	private endContainer(character: '}' | ']'): void {
		const frame = this.frames.pop();
		if (!frame || (character === '}' ? frame.kind !== 'object' : frame.kind !== 'array')) {
			throw new OpenRouterAudioJsonError('invalid_json', 'Invalid JSON body');
		}
		this.completeValue();
	}

	private valuePath(): string[] {
		const frame = this.frames[this.frames.length - 1];
		if (!frame) return [];
		if (frame.kind === 'object') {
			return frame.key == null ? [...frame.path] : [...frame.path, frame.key];
		}
		return [...frame.path, '[]'];
	}

	private completeValue(): void {
		const frame = this.frames[this.frames.length - 1];
		if (!frame) {
			this.rootState = 'done';
			return;
		}
		if (frame.kind === 'object') {
			frame.state = 'comma_or_end';
		} else {
			frame.state = 'comma_or_end';
		}
	}

	private appendSanitized(value: string): void {
		let index = 0;
		if (this.pendingHighSurrogate) {
			const first = value.charCodeAt(0);
			if (first >= 0xdc00 && first <= 0xdfff) {
				this.sanitizedUtf8Bytes += 4;
				index = 1;
			} else {
				// An unpaired UTF-16 surrogate is encoded as U+FFFD by TextEncoder.
				this.sanitizedUtf8Bytes += 3;
			}
			this.pendingHighSurrogate = false;
		}
		while (index < value.length) {
			const codeUnit = value.charCodeAt(index);
			if (codeUnit <= 0x7f) {
				this.sanitizedUtf8Bytes += 1;
			} else if (codeUnit <= 0x7ff) {
				this.sanitizedUtf8Bytes += 2;
			} else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
				const next = value.charCodeAt(index + 1);
				if (next >= 0xdc00 && next <= 0xdfff) {
					this.sanitizedUtf8Bytes += 4;
					index += 1;
				} else if (index + 1 === value.length) {
					this.pendingHighSurrogate = true;
				} else {
					this.sanitizedUtf8Bytes += 3;
				}
			} else {
				this.sanitizedUtf8Bytes += 3;
			}
			index += 1;
		}
		if (this.sanitizedUtf8Bytes > this.maxMetadataBytes) {
			throw new OpenRouterAudioJsonError(
				'payload_too_large',
				`Audio transcription JSON metadata must be at most ${this.maxMetadataBytes} bytes`,
			);
		}
		this.sanitizedParts.push(value);
	}
}

function decodeUtf8Chunk(
	decoder: TextDecoder,
	value?: Uint8Array,
	stream = false,
): string {
	try {
		return value === undefined
			? decoder.decode()
			: decoder.decode(value, { stream });
	} catch {
		throw new OpenRouterAudioJsonError('invalid_json', 'JSON body must be valid UTF-8');
	}
}

function parseDeclaredContentLength(request: Request): number | null {
	const raw = request.headers.get('content-length');
	if (raw == null || raw.trim() === '') return null;
	if (!/^\d+$/.test(raw.trim())) {
		throw new OpenRouterAudioJsonError('invalid_request', 'Invalid Content-Length header');
	}
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new OpenRouterAudioJsonError('invalid_request', 'Invalid Content-Length header');
	}
	return value;
}

async function readWithAbort(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
	if (signal.aborted) {
		throw new OpenRouterAudioJsonError('cancelled', 'Audio transcription request was cancelled');
	}
	return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
		const onAbort = () => {
			cleanup();
			reject(new OpenRouterAudioJsonError('cancelled', 'Audio transcription request was cancelled'));
		};
		const cleanup = () => signal.removeEventListener('abort', onAbort);
		signal.addEventListener('abort', onAbort, { once: true });
		if (signal.aborted) {
			onAbort();
			return;
		}
		reader.read().then(
			(result) => {
				cleanup();
				resolve(result);
			},
			(error: unknown) => {
				cleanup();
				reject(error);
			},
		);
	});
}

/** Parse one bounded JSON body without ever retaining the base64 string. */
export async function parseOpenRouterAudioJson(
	request: Request,
	limits: OpenRouterAudioJsonLimits = {},
): Promise<OpenRouterAudioJsonResult> {
	const maxDecodedBytes = boundedPositiveInteger(
		limits.maxDecodedBytes,
		OPENROUTER_AUDIO_JSON_MAX_DECODED_BYTES,
	);
	const maxMetadataBytes = boundedPositiveInteger(
		limits.maxMetadataBytes,
		OPENROUTER_AUDIO_JSON_MAX_METADATA_BYTES,
	);
	const derivedRequestLimit = Math.ceil(maxDecodedBytes / 3) * 4 + maxMetadataBytes;
	const maxRequestBytes = boundedPositiveInteger(
		limits.maxRequestBytes,
		Math.min(OPENROUTER_AUDIO_JSON_MAX_REQUEST_BYTES, derivedRequestLimit),
	);
	const declaredLength = parseDeclaredContentLength(request);
	if (declaredLength != null && declaredLength > maxRequestBytes) {
		await request.body?.cancel('audio_json_request_too_large').catch(() => undefined);
		throw new OpenRouterAudioJsonError(
			'payload_too_large',
			`Audio transcription JSON body must be at most ${maxRequestBytes} bytes`,
		);
	}
	if (!request.body) {
		throw new OpenRouterAudioJsonError('invalid_json', 'Missing JSON body');
	}

	const reader = request.body.getReader();
	// Keep a leading BOM visible so it cannot bypass the UTF-8 metadata byte ceiling.
	// JSON.parse then rejects it because the public contract requires strict JSON.
	const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
	const extractor = new StreamingAudioJsonExtractor(
		new BoundedBase64Decoder(maxDecodedBytes),
		maxMetadataBytes,
	);
	let receivedBytes = 0;
	try {
		for (;;) {
			const { done, value } = await readWithAbort(reader, request.signal);
			if (done) break;
			receivedBytes += value.byteLength;
			if (receivedBytes > maxRequestBytes) {
				throw new OpenRouterAudioJsonError(
					'payload_too_large',
					`Audio transcription JSON body must be at most ${maxRequestBytes} bytes`,
				);
			}
			extractor.push(decodeUtf8Chunk(utf8, value, true));
		}
		extractor.push(decodeUtf8Chunk(utf8));
		return extractor.finish();
	} catch (error) {
		await reader.cancel('audio_json_request_rejected').catch(() => undefined);
		if (error instanceof OpenRouterAudioJsonError) throw error;
		if (request.signal.aborted) {
			throw new OpenRouterAudioJsonError('cancelled', 'Audio transcription request was cancelled');
		}
		if (error instanceof TypeError && /encoding|utf-?8/i.test(error.message)) {
			throw new OpenRouterAudioJsonError('invalid_json', 'JSON body must be valid UTF-8');
		}
		throw new OpenRouterAudioJsonError('invalid_json', 'Invalid JSON body');
	} finally {
		reader.releaseLock();
	}
}
