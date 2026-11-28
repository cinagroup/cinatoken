/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
export const PUBLIC_GITHUB_URL = 'https://github.com/cinagroup/cinatoken'
export const PUBLIC_ENGINEERING_DOCS_URL = `${PUBLIC_GITHUB_URL}/blob/main/docs/README.md`
export function publicDocsHref(locale?: string): string {
	return publicContentHref('docs', locale)
}

export function publicContentHref(
	section: 'docs' | 'updates' | 'reference/catalog/models',
	locale?: string
): string {
	return `/${locale?.toLowerCase().startsWith('zh') ? 'zh' : 'en'}/${section}/`
}
