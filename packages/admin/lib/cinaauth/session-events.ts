const SESSION_EVENT = 'cinatoken:session-changed';
const SESSION_CHANNEL = 'cinatoken:session:v1';
const SESSION_STORAGE_KEY = 'cinatoken:session-event:v1';

export type SessionChange = 'login' | 'logout';
type SessionMessage = { type: typeof SESSION_EVENT; change: SessionChange; id: string };

function parseMessage(value: unknown): SessionMessage | null {
	if (!value || typeof value !== 'object') return null;
	const candidate = value as Record<string, unknown>;
	if (candidate.type !== SESSION_EVENT || (candidate.change !== 'login' && candidate.change !== 'logout') || typeof candidate.id !== 'string') return null;
	return candidate as SessionMessage;
}

/** Send no user data or tokens. Login notifications only request server revalidation. */
export function notifyCinaAuthSessionChanged(change: SessionChange): void {
	const message: SessionMessage = { type: SESSION_EVENT, change, id: crypto.randomUUID() };
	window.dispatchEvent(new CustomEvent(SESSION_EVENT, { detail: message }));
	try {
		const channel = new BroadcastChannel(SESSION_CHANNEL);
		channel.postMessage(message);
		channel.close();
	} catch { /* Storage covers browsers without BroadcastChannel. */ }
	try {
		localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(message));
		localStorage.removeItem(SESSION_STORAGE_KEY);
	} catch { /* No persistent browser storage is required. */ }
}

export function subscribeCinaAuthSessionChanges(onChange: (change: SessionChange) => void): () => void {
	// The same event may arrive through both transports. Bound the deduplication set.
	const seen = new Set<string>();
	const receive = (value: unknown) => {
		const message = parseMessage(value);
		if (!message || seen.has(message.id)) return;
		seen.add(message.id);
		if (seen.size > 32) seen.delete(seen.values().next().value!);
		onChange(message.change);
	};
	const local = (event: Event) => receive((event as CustomEvent<unknown>).detail);
	const storage = (event: StorageEvent) => {
		if (event.key !== SESSION_STORAGE_KEY || !event.newValue) return;
		try { receive(JSON.parse(event.newValue) as unknown); } catch { /* Ignore invalid signals. */ }
	};
	let channel: BroadcastChannel | undefined;
	try {
		channel = new BroadcastChannel(SESSION_CHANNEL);
		channel.onmessage = (event: MessageEvent<unknown>) => receive(event.data);
	} catch { /* Optional browser transport. */ }
	window.addEventListener(SESSION_EVENT, local);
	window.addEventListener('storage', storage);
	return () => {
		window.removeEventListener(SESSION_EVENT, local);
		window.removeEventListener('storage', storage);
		channel?.close();
	};
}
