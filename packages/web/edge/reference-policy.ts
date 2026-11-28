/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
export function referenceAssetPath(path: string): string | null {
	const match = path.match(
		/^\/reference\/(?:api\/catalog|catalog)\/(models|providers)(?:\.json)?\/?$/
	)
	if (match) return `/reference/catalog/${match[1]}.json`
	const vendor = path.match(
		/^\/reference\/(?:api\/catalog|catalog)\/models-by-vendor\/([a-z0-9_-]+?)(?:\.json)?\/?$/
	)
	return vendor ? `/reference/catalog/models-by-vendor/${vendor[1]}.json` : null
}
export function ownsReferencePath(path: string): boolean {
	return (
		path.startsWith('/reference/api/catalog/') ||
		path.startsWith('/reference/catalog/')
	)
}
