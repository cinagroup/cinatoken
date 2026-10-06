/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { loadEnv } from '@rsbuild/core'

export const WEB_PUBLIC_ENV_NAMES: readonly []
export function loadWebBuildEnvironment(
	packageRoot: string,
	mode?: string
): ReturnType<typeof loadEnv> & { values: Record<string, string> }
