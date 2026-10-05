/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import './styles/index.css'

async function startApplication(): Promise<void> {
	const element = document.getElementById('root')
	if (!element) throw new Error('CinaToken application root is missing')
	const script = document.getElementById('cinatoken-public-bootstrap')
	if (script) {
		const { parsePublicBootstrap, hydratePublicRoot } =
			await import('./cinatoken/public/ssr')
		const bootstrap = parsePublicBootstrap(script.textContent || '')
		await hydratePublicRoot(element, bootstrap)
		return
	}
	const { startLegacyApplication } = await import('./legacy-root')
	startLegacyApplication(element)
}

void startApplication().catch((error: unknown) => {
	document.documentElement.dataset.cinatokenHydration = 'failed'
	queueMicrotask(() => {
		throw error
	})
})
