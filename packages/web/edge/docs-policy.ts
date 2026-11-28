/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
export const DOCS_PAGE_PATTERN =
	/^\/(en|zh)\/(?:docs|updates|reference)(?:\/[a-z0-9-]+)*\/?$/
export const DOCS_CSP =
	"default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"

export function legacyDocsRedirect(path: string): string | null {
	const match = path.match(
		/^\/(en|zh)\/docs\/(quick-start|guides\/api-keys|guides\/models)\/?$/
	)
	if (!match) return null
	const targets: Record<string, string> = {
		'quick-start': 'quickstart',
		'guides/api-keys': 'keys',
		'guides/models': 'models',
	}
	return `/${match[1]}/docs/${targets[match[2]!]}/`
}
