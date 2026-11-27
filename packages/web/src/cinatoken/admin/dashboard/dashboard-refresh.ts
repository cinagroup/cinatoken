/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
export const dashboardRefreshIntervals = [
	0, 10000, 30000, 60000, 300000,
] as const
const key = 'octafuse.admin.dashboard.refreshIntervalMs'
const event = 'octafuse-admin-dashboard-refresh-interval'
export function readDashboardRefresh(): number {
	try {
		return parseDashboardRefresh(window.localStorage.getItem(key))
	} catch {
		return 0
	}
}
export function parseDashboardRefresh(raw: string | null): number {
	const value = Number(raw?.replace(/_/g, ''))
	return dashboardRefreshIntervals.find((interval) => interval === value) ?? 0
}
export function writeDashboardRefresh(value: number): void {
	const valid = parseDashboardRefresh(String(value))
	try {
		window.localStorage.setItem(key, valid ? String(valid) : 'off')
	} catch {
		/* Private browsing remains usable. */
	}
	window.dispatchEvent(new Event(event))
}
export function subscribeDashboardRefresh(onChange: () => void): () => void {
	const changed = (e: StorageEvent) => {
		if (e.key === key || e.key === null) onChange()
	}
	window.addEventListener('storage', changed)
	window.addEventListener(event, onChange)
	return () => {
		window.removeEventListener('storage', changed)
		window.removeEventListener(event, onChange)
	}
}
