/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { AnyRouter } from '@tanstack/react-router'

/** Reload failed loaders and lazy imports before resetting a render boundary. */
export async function retryFailedRoute(
	router: Pick<AnyRouter, 'invalidate'>,
	reset: () => void
): Promise<void> {
	await router.invalidate({ sync: true })
	reset()
}
