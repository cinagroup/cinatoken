const SESSION_EVENT = 'cinatoken:session-changed'
const SESSION_CHANNEL = 'cinatoken:session:v1'
const SESSION_STORAGE_KEY = 'cinatoken:session-event:v1'

export type SessionChange = 'login' | 'logout' | 'workspace'
type SessionMessage = {
	type: typeof SESSION_EVENT
	change: SessionChange
	id: string
}

export function parseSessionMessage(value: unknown): SessionMessage | null {
	if (!value || typeof value !== 'object') return null
	const candidate = value as Record<string, unknown>
	if (
		candidate.type !== SESSION_EVENT ||
		(candidate.change !== 'login' &&
			candidate.change !== 'logout' &&
			candidate.change !== 'workspace') ||
		typeof candidate.id !== 'string' ||
		!candidate.id ||
		candidate.id.length > 128
	)
		return null
	return {
		type: SESSION_EVENT,
		change: candidate.change as SessionChange,
		id: candidate.id,
	}
}

/** Only an ephemeral event id and action are stored; identity and credentials remain on the server. */
export function notifySessionChanged(change: SessionChange): void {
	const message: SessionMessage = {
		type: SESSION_EVENT,
		change,
		id: crypto.randomUUID(),
	}
	window.dispatchEvent(new CustomEvent(SESSION_EVENT, { detail: message }))
	try {
		const channel = new BroadcastChannel(SESSION_CHANNEL)
		channel.postMessage(message)
		channel.close()
	} catch {
		/* Optional transport. */
	}
	try {
		localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(message))
		localStorage.removeItem(SESSION_STORAGE_KEY)
	} catch {
		/* Browser storage is not required. */
	}
}

export function subscribeSessionChanges(
	onChange: (change: SessionChange) => void
): () => void {
	const seen = new Set<string>()
	const receive = (value: unknown): void => {
		const message = parseSessionMessage(value)
		if (!message || seen.has(message.id)) return
		seen.add(message.id)
		if (seen.size > 32) {
			const oldest = seen.values().next().value
			if (oldest) seen.delete(oldest)
		}
		onChange(message.change)
	}
	const local = (event: Event) =>
		receive((event as CustomEvent<unknown>).detail)
	const storage = (event: StorageEvent): void => {
		if (event.key !== SESSION_STORAGE_KEY || !event.newValue) return
		try {
			receive(JSON.parse(event.newValue) as unknown)
		} catch {
			/* Invalid signal. */
		}
	}
	let channel: BroadcastChannel | undefined
	try {
		channel = new BroadcastChannel(SESSION_CHANNEL)
		channel.onmessage = (event: MessageEvent<unknown>) => receive(event.data)
	} catch {
		/* Optional transport. */
	}
	window.addEventListener(SESSION_EVENT, local)
	window.addEventListener('storage', storage)
	return () => {
		window.removeEventListener(SESSION_EVENT, local)
		window.removeEventListener('storage', storage)
		channel?.close()
	}
}
