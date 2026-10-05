/**
 * Persist Sticky summary auto-refresh interval (Routes page toolbar).
 * Same localStorage + custom-event pattern as `flowDensity` on the Routes page.
 */

export type StickyRefreshIntervalMs = "off" | 60_000 | 300_000 | 600_000;

export const STICKY_REFRESH_INTERVAL_OPTIONS: readonly StickyRefreshIntervalMs[] =
	["off", 60_000, 300_000, 600_000] as const;

const STORAGE_KEY = "octafuse.admin.routes.stickyRefreshIntervalMs";
const EVENT = "octafuse-admin-routes-sticky-refresh-interval";

function parseStoredInterval(raw: string | null): StickyRefreshIntervalMs {
	if (raw === "60000" || raw === "60_000") return 60_000;
	if (raw === "300000" || raw === "300_000") return 300_000;
	if (raw === "600000" || raw === "600_000") return 600_000;
	return "off";
}

export function readStickyRefreshInterval(): StickyRefreshIntervalMs {
	if (typeof window === "undefined") return "off";
	try {
		return parseStoredInterval(window.localStorage.getItem(STORAGE_KEY));
	} catch {
		return "off";
	}
}

export function writeStickyRefreshInterval(
	value: StickyRefreshIntervalMs
): void {
	try {
		window.localStorage.setItem(
			STORAGE_KEY,
			value === "off" ? "off" : String(value)
		);
	} catch {
		// Ignore quota / private-mode failures; preference is best-effort.
	}
	window.dispatchEvent(new Event(EVENT));
}

export function subscribeStickyRefreshInterval(
	onStoreChange: () => void
): () => void {
	window.addEventListener("storage", onStoreChange);
	window.addEventListener(EVENT, onStoreChange);
	return () => {
		window.removeEventListener("storage", onStoreChange);
		window.removeEventListener(EVENT, onStoreChange);
	};
}
