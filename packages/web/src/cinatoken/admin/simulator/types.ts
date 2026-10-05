/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { GatewayKeyRow } from '../gateway-keys/gateway-key-contracts'
import type { SimulatorModel, SimulatorRoute } from './simulator-contracts'

export type AdminKeyListItem = GatewayKeyRow
export type AdminModelRow = SimulatorModel
export type RouteListRow = SimulatorRoute
export type ResponseMeta = {
	status: number | null
	latencyMs: string | null
	requestUrl: string | null
	contentType: string | null
	generationId: string | null
	outcome: 'running' | 'complete' | 'failed' | 'cancelled' | 'unknown'
}
export type WirePreview = {
	method: 'POST' | 'WebSocket'
	url: string
	headers: Record<string, string>
	bodyText: string
	isMultipart?: boolean
}
export type SimulatorSession = {
	scopeKey: string
	reconciliationKey: string
	subject: string
	enabled: boolean
	canReadKeys?: boolean
	canReadLogs?: boolean
	revalidate?: () => Promise<unknown>
}
