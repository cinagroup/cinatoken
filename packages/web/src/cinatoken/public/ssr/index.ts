/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { Root } from 'react-dom/client'
import type { PublicBootstrap } from './public-bootstrap'

export { PublicApplication } from './public-application'
export {
	createPublicRequestApp,
	preparePublicRequest,
} from './public-request-app'
export type {
	PublicRequestInput,
	PublicRequestApp,
	PreparedPublicRequest,
} from './public-request-app'
export {
	PUBLIC_BOOTSTRAP_MAX_BYTES,
	parsePublicBootstrap,
	serializePublicBootstrap,
	publicBootstrapSchema,
	publicSnapshotSchema,
	safePublicError,
} from './public-bootstrap'
export type {
	PublicBootstrap,
	PublicSnapshot,
	SafePublicError,
} from './public-bootstrap'
export {
	PUBLIC_LOCALES,
	createPublicLocation,
	localizePublicHref,
	isPublicLocale,
	isPublicPagePath,
	unprefixPublicPath,
} from './public-location'
export type { PublicLocale, PublicLocation } from './public-location'
export { classifyPublicRoute, localeFromPublicPath } from './public-route'
export type { PublicRoute } from './public-route'

/** Browser code stays out of the request renderer's static dependency graph. */
export async function hydratePublicRoot(
	element: Element,
	bootstrap: PublicBootstrap
): Promise<Root> {
	const client = await import('./hydrate-public-root')
	return client.hydratePublicRoot(element, bootstrap)
}
