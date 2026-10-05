/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { SessionSnapshot } from '../session'
import type {
	ConsoleSessionIdentity,
	ConsoleSessionSnapshot,
} from './console-session'

/** Portal supplies cache identity; the live console check independently proves its subject and role. */
export function consoleIdentityForPortal(
	session: SessionSnapshot
): ConsoleSessionIdentity | null {
	if (
		!session.user ||
		(session.status !== 'authenticated' && session.status !== 'unavailable') ||
		session.isRefreshing ||
		session.isLoggingOut ||
		session.isSwitchingWorkspace
	)
		return null
	return {
		userId: session.user.userId,
		subject: session.user.subject,
		epoch: session.scopeVersion,
	}
}

/** Render guard closes the gap before an effect reconciles a changed portal identity. */
export function consoleMatchesPortal(
	console: ConsoleSessionSnapshot,
	portal: ConsoleSessionIdentity | null
): boolean {
	return (
		!!portal &&
		console.status === 'verified' &&
		console.canWrite &&
		console.identity?.userId === portal.userId &&
		console.identity.subject === portal.subject &&
		console.identity.epoch === portal.epoch
	)
}

export function consoleScopeKey(
	identity: ConsoleSessionIdentity,
	accessVersion: number
): string {
	return JSON.stringify([
		identity.userId,
		identity.subject,
		identity.epoch,
		accessVersion,
	])
}
