/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	stripSearchParams,
	type SearchMiddleware,
} from '@tanstack/react-router'

/**
 * Validation produces complete page state, but does not force users' valid URLs to
 * serialize every default. Explicit navigation still carries a changed state.
 */
export function preservePublicSearch<T extends object>(
	validate: (value: unknown) => T,
	currentSearch: () => Record<string, unknown>
): SearchMiddleware<T> {
	return (context) => {
		const defaults: Partial<T> = { ...validate({}) }
		const current = currentSearch()
		for (const key in defaults) {
			if (Object.prototype.hasOwnProperty.call(current, key))
				delete defaults[key]
		}
		return stripSearchParams<T>(defaults)(context)
	}
}
