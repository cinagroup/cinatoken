export const PUBLIC_CHAT_MAX_BODY_BYTES = 12 * 1024 * 1024;
export const PUBLIC_CHAT_MAX_ATTACHMENTS = 4;
export const PUBLIC_CHAT_MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
export const PUBLIC_CHAT_MAX_TOTAL_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const PUBLIC_CHAT_STORAGE_KEY = 'cinatoken.public-chat.session.v1';

export class PublicChatBodyTooLargeError extends Error {
	constructor() {
		super('Public chat request body is too large');
		this.name = 'PublicChatBodyTooLargeError';
	}
}

/** Buffer a public-chat request only up to the raw-byte ceiling. */
export async function readPublicChatBodyWithinLimit(
	request: Request,
	maxBytes = PUBLIC_CHAT_MAX_BODY_BYTES,
): Promise<string> {
	const contentLength = request.headers.get('content-length');
	if (contentLength != null) {
		const declared = Number(contentLength);
		if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes) {
			await request.body?.cancel('public_chat_body_too_large').catch(() => undefined);
			throw new PublicChatBodyTooLargeError();
		}
	}
	if (!request.body) return '';

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let byteLength = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			byteLength += value.byteLength;
			if (byteLength > maxBytes) {
				await reader.cancel('public_chat_body_too_large').catch(() => undefined);
				throw new PublicChatBodyTooLargeError();
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(byteLength);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export type PublicChatTextPart = {
	type: 'text';
	text: string;
};

export type PublicChatImagePart = {
	type: 'image_url';
	image_url: {
		url: string;
		detail?: 'auto' | 'low' | 'high';
	};
};

export type PublicChatMessage = {
	role: 'system' | 'user' | 'assistant';
	content: string | Array<PublicChatTextPart | PublicChatImagePart>;
};

export type PublicChatRequest = {
	model: string;
	messages: PublicChatMessage[];
};

export type PublicChatStreamEvent =
	| { type: 'text'; text: string }
	| { type: 'done' }
	| { type: 'error'; message: string };

export type PublicChatStoredSession = {
	version: 1;
	modelId: string;
	messages: Array<{ role: 'user' | 'assistant'; content: string }>;
};

const ALLOWED_ROLES = new Set<PublicChatMessage['role']>(['system', 'user', 'assistant']);
const IMAGE_DATA_URL = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/;
const MAX_MESSAGES = 50;
const MAX_TEXT_CHARACTERS = 100_000;

function decodedBase64Bytes(value: string): number {
	const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
	return Math.floor((value.length * 3) / 4) - padding;
}

function hasExpectedImageSignature(mimeSubtype: string, base64: string): boolean {
	if (mimeSubtype === 'png') return base64.startsWith('iVBORw0KGgo');
	if (mimeSubtype === 'jpeg') return base64.startsWith('/9j/');
	if (mimeSubtype === 'webp') return base64.startsWith('UklGR');
	if (mimeSubtype === 'gif') return base64.startsWith('R0lGODdh') || base64.startsWith('R0lGODlh');
	return false;
}

function sanitizeMultimodalContent(
	value: unknown,
	counters: { characters: number; images: number; imageBytes: number },
): Array<PublicChatTextPart | PublicChatImagePart> | null {
	if (!Array.isArray(value) || value.length < 1 || value.length > PUBLIC_CHAT_MAX_ATTACHMENTS + 1) return null;
	const parts: Array<PublicChatTextPart | PublicChatImagePart> = [];

	for (const part of value) {
		if (!part || typeof part !== 'object') return null;
		const type = (part as { type?: unknown }).type;
		if (type === 'text') {
			const text = (part as { text?: unknown }).text;
			if (typeof text !== 'string' || !text.trim()) return null;
			counters.characters += text.length;
			if (counters.characters > MAX_TEXT_CHARACTERS) return null;
			parts.push({ type: 'text', text });
			continue;
		}
		if (type !== 'image_url') return null;
		const imageUrl = (part as { image_url?: unknown }).image_url;
		if (!imageUrl || typeof imageUrl !== 'object') return null;
		const url = (imageUrl as { url?: unknown }).url;
		const detail = (imageUrl as { detail?: unknown }).detail;
		if (typeof url !== 'string') return null;
		const match = IMAGE_DATA_URL.exec(url);
		if (!match?.[1] || !match[2] || !hasExpectedImageSignature(match[1], match[2])) return null;
		if (detail !== undefined && detail !== 'auto' && detail !== 'low' && detail !== 'high') return null;
		const bytes = decodedBase64Bytes(match[2]);
		counters.images += 1;
		counters.imageBytes += bytes;
		if (
			bytes < 1 ||
			bytes > PUBLIC_CHAT_MAX_ATTACHMENT_BYTES ||
			counters.images > PUBLIC_CHAT_MAX_ATTACHMENTS ||
			counters.imageBytes > PUBLIC_CHAT_MAX_TOTAL_ATTACHMENT_BYTES
		) return null;
		parts.push({
			type: 'image_url',
			image_url: detail === undefined ? { url } : { url, detail },
		});
	}

	return parts.some((part) => part.type === 'image_url') ? parts : null;
}

export function coercePublicChatRequest(value: unknown): PublicChatRequest | null {
	if (!value || typeof value !== 'object') return null;
	const model = (value as { model?: unknown }).model;
	const messages = (value as { messages?: unknown }).messages;
	if (typeof model !== 'string' || !model.trim() || model.length > 180) return null;
	if (!Array.isArray(messages) || messages.length < 1 || messages.length > MAX_MESSAGES) return null;

	const counters = { characters: 0, images: 0, imageBytes: 0 };
	const sanitized: PublicChatMessage[] = [];
	for (const valueMessage of messages) {
		if (!valueMessage || typeof valueMessage !== 'object') return null;
		const role = (valueMessage as { role?: unknown }).role;
		const content = (valueMessage as { content?: unknown }).content;
		if (typeof role !== 'string' || !ALLOWED_ROLES.has(role as PublicChatMessage['role'])) return null;

		if (typeof content === 'string') {
			if (!content.trim()) return null;
			counters.characters += content.length;
			if (counters.characters > MAX_TEXT_CHARACTERS) return null;
			sanitized.push({ role: role as PublicChatMessage['role'], content });
			continue;
		}

		if (role !== 'user') return null;
		const parts = sanitizeMultimodalContent(content, counters);
		if (!parts) return null;
		sanitized.push({ role: 'user', content: parts });
	}

	return { model: model.trim(), messages: sanitized };
}

export function parsePublicChatResponseText(value: unknown): string | null {
	if (!value || typeof value !== 'object') return null;
	const choices = (value as { choices?: unknown }).choices;
	if (!Array.isArray(choices)) return null;
	const message = choices[0] && typeof choices[0] === 'object' ? (choices[0] as { message?: unknown }).message : null;
	if (!message || typeof message !== 'object') return null;
	const content = (message as { content?: unknown }).content;
	return typeof content === 'string' && content.trim() ? content : null;
}

export function parsePublicChatResponseError(value: unknown): string | null {
	if (!value || typeof value !== 'object') return null;
	const error = (value as { error?: unknown }).error;
	if (!error || typeof error !== 'object') return null;
	const message = (error as { message?: unknown }).message;
	return typeof message === 'string' && message.trim() ? message.slice(0, 500) : null;
}

function parseStreamData(data: string): PublicChatStreamEvent[] {
	if (data === '[DONE]') return [{ type: 'done' }];
	let value: unknown;
	try {
		value = JSON.parse(data);
	} catch {
		return [{ type: 'error', message: 'The gateway returned an invalid stream event.' }];
	}
	const error = parsePublicChatResponseError(value);
	if (error) return [{ type: 'error', message: error }];
	if (!value || typeof value !== 'object') return [];
	const choices = (value as { choices?: unknown }).choices;
	if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== 'object') return [];
	const delta = (choices[0] as { delta?: unknown }).delta;
	if (!delta || typeof delta !== 'object') return [];
	const content = (delta as { content?: unknown }).content;
	if (typeof content === 'string' && content) return [{ type: 'text', text: content }];
	if (Array.isArray(content)) {
		return content.flatMap((part): PublicChatStreamEvent[] => {
			if (!part || typeof part !== 'object') return [];
			const text = (part as { text?: unknown }).text;
			return typeof text === 'string' && text ? [{ type: 'text', text }] : [];
		});
	}
	return [];
}

/** Incremental SSE decoder that tolerates arbitrary network chunk boundaries. */
export class PublicChatSseDecoder {
	private buffer = '';
	private dataLines: string[] = [];

	push(chunk: string): PublicChatStreamEvent[] {
		this.buffer += chunk;
		const lines = this.buffer.split('\n');
		this.buffer = lines.pop() ?? '';
		return lines.flatMap((line) => this.consumeLine(line));
	}

	finish(): PublicChatStreamEvent[] {
		const events = this.buffer ? this.consumeLine(this.buffer) : [];
		this.buffer = '';
		return [...events, ...this.flushEvent()];
	}

	private consumeLine(rawLine: string): PublicChatStreamEvent[] {
		const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
		if (!line) return this.flushEvent();
		if (line.startsWith(':')) return [];
		if (line === 'data') this.dataLines.push('');
		else if (line.startsWith('data:')) this.dataLines.push(line.slice(5).replace(/^ /, ''));
		return [];
	}

	private flushEvent(): PublicChatStreamEvent[] {
		if (this.dataLines.length === 0) return [];
		const data = this.dataLines.join('\n');
		this.dataLines = [];
		return parseStreamData(data);
	}
}

export function parsePublicChatStoredSession(raw: string): PublicChatStoredSession | null {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!value || typeof value !== 'object') return null;
	const version = (value as { version?: unknown }).version;
	const modelId = (value as { modelId?: unknown }).modelId;
	const messages = (value as { messages?: unknown }).messages;
	if (version !== 1 || typeof modelId !== 'string' || !modelId.trim() || modelId.length > 180) return null;
	if (!Array.isArray(messages) || messages.length > MAX_MESSAGES) return null;

	let characters = 0;
	const sanitized: PublicChatStoredSession['messages'] = [];
	for (const message of messages) {
		if (!message || typeof message !== 'object') return null;
		const role = (message as { role?: unknown }).role;
		const content = (message as { content?: unknown }).content;
		if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string' || !content.trim()) return null;
		characters += content.length;
		if (characters > MAX_TEXT_CHARACTERS) return null;
		sanitized.push({ role, content });
	}
	return { version: 1, modelId: modelId.trim(), messages: sanitized };
}
