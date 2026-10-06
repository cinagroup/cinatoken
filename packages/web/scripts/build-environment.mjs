/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { loadEnv } from '@rsbuild/core'

// Browser requests use same-origin URLs and runtime bootstrap data. No custom
// build-time environment variable is currently approved for the browser.
export const WEB_PUBLIC_ENV_NAMES = Object.freeze([])

/** @param {string} packageRoot @param {string | undefined} mode */
export function loadWebBuildEnvironment(packageRoot, mode) {
	/** @type {Record<string, string>} */
	const values = {}
	for (const [name, value] of Object.entries(process.env)) {
		if (value !== undefined) values[name] = value
	}
	// Isolate dotenv expansion so a dev restart reads changed private proxy values.
	const env = loadEnv({
		cwd: packageRoot,
		mode,
		prefixes: [],
		processEnv: values,
	})
	const allowed = new Set(WEB_PUBLIC_ENV_NAMES)
	const unexpected = Object.keys(values)
		.filter((name) => name.startsWith('PUBLIC_') && !allowed.has(name))
		.sort()
	if (unexpected.length) {
		// Report names only: a misplaced secret must never appear in build logs.
		throw new Error(
			`Unapproved Web public environment names: ${unexpected.join(', ')}`
		)
	}
	return { ...env, values }
}
