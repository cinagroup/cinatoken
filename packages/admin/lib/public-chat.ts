export type PublicChatMessage = {
	role: 'system' | 'user' | 'assistant';
	content: string;
};

export type PublicChatRequest = {
	model: string;
	messages: PublicChatMessage[];
};

const ALLOWED_ROLES = new Set<PublicChatMessage['role']>(['system', 'user', 'assistant']);

export function coercePublicChatRequest(value: unknown): PublicChatRequest | null {
	if (!value || typeof value !== 'object') return null;
	const model = (value as { model?: unknown }).model;
	const messages = (value as { messages?: unknown }).messages;
	if (typeof model !== 'string' || !model.trim() || model.length > 180) return null;
	if (!Array.isArray(messages) || messages.length < 1 || messages.length > 50) return null;

	let characters = 0;
	const sanitized: PublicChatMessage[] = [];
	for (const valueMessage of messages) {
		if (!valueMessage || typeof valueMessage !== 'object') return null;
		const role = (valueMessage as { role?: unknown }).role;
		const content = (valueMessage as { content?: unknown }).content;
		if (typeof role !== 'string' || !ALLOWED_ROLES.has(role as PublicChatMessage['role'])) return null;
		if (typeof content !== 'string' || !content.trim()) return null;
		characters += content.length;
		if (characters > 100_000) return null;
		sanitized.push({ role: role as PublicChatMessage['role'], content });
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
