/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { RsbuildPlugin } from '@rsbuild/core'

export interface WebBuildContract {
	version: 1 | 2
	buildId: string
	sourceSha256: string
}
export const BUILD_CONTRACT_FILE: 'build-contract.json'
export function webSourceSha256(
	packageRoot: string,
	options?: { version?: 1 | 2 }
): string
export function readBuildContract(directory: string): WebBuildContract
export function verifyBuildPair(
	browserDirectory: string,
	serverDirectory: string
): WebBuildContract
export function assertWorkerNoNodeImports(directory: string): void
export function pluginWebBuildContract(packageRoot: string): RsbuildPlugin
