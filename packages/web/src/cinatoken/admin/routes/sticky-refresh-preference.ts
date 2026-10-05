/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
export type StickyRefreshInterval = 0 | 60000 | 300000 | 600000
const key = 'octafuse.admin.routes.stickyRefreshIntervalMs'
const event = 'octafuse-admin-routes-sticky-refresh-interval'

export function parseStickyRefreshInterval(
	raw: string | null
): StickyRefreshInterval {
	if (raw === '60000' || raw === '60_000') return 60000
	if (raw === '300000' || raw === '300_000') return 300000
	if (raw === '600000' || raw === '600_000') return 600000
	return 0
}
/** Only a non-sensitive UI timer preference is persisted. Summary, bindings and drafts remain in memory. */
export function readStickyRefreshInterval(): StickyRefreshInterval {
	if (typeof window === 'undefined') return 0
	try {
		return parseStickyRefreshInterval(window.localStorage.getItem(key))
	} catch {
		return 0
	}
}
export function writeStickyRefreshInterval(value: StickyRefreshInterval): void {
	if (typeof window === 'undefined') return
	try {
		window.localStorage.setItem(key, value ? String(value) : 'off')
	} catch {
		/* UI preference is best effort; critical recovery markers are managed separately. */
	}
	window.dispatchEvent(new Event(event))
}
export function subscribeStickyRefreshInterval(notify: () => void): () => void {
	window.addEventListener('storage', notify)
	window.addEventListener(event, notify)
	return () => {
		window.removeEventListener('storage', notify)
		window.removeEventListener(event, notify)
	}
}
