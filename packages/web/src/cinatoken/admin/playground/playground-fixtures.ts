/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { PlaygroundContext, PlaygroundRoute } from './playground-contracts'

export function fixtureRoute(
	overrides: Partial<PlaygroundRoute> = {}
): PlaygroundRoute {
	return {
		id: 'r-text',
		model_id: 'm-text',
		provider_id: 'p-openai',
		provider_model_name: 'gpt-test',
		priority: 1,
		status: 'inactive',
		route_group: 'default',
		upstream_protocol: 'openai',
		upstream_operation: 'chat',
		adapter: 'passthrough',
		model_name: 'Text model',
		provider_name: 'Provider',
		provider_status: 'active',
		surfaces: [],
		...overrides,
	}
}
export function fixtureContext(): PlaygroundContext {
	return {
		routes: [fixtureRoute()],
		models: [
			{
				id: 'm-text',
				display_name: 'Text',
				kind: 'llm',
				input_modalities: ['text'],
				output_modalities: ['text'],
			},
		],
		providers: [{ id: 'p-openai', name: 'Provider', status: 'active' }],
		tools: [
			{
				toolId: 'web-search',
				catalog_state: 'available',
				providers: ['bocha', 'tavily', 'cleversee', 'tencent_wsa'].map(
					(provider) => ({
						provider,
						available: true,
						configured: false,
						active: false,
					})
				),
			},
			{
				toolId: 'web-fetch',
				catalog_state: 'available',
				providers: ['firecrawl', 'tavily', 'jina'].map((provider) => ({
					provider,
					available: true,
					configured: true,
					active: false,
				})),
			},
			{
				toolId: 'web-deep-search',
				catalog_state: 'available',
				providers: ['firecrawl', 'jina'].map((provider) => ({
					provider,
					available: true,
					configured: true,
					active: false,
				})),
			},
			{
				toolId: 'ai-detection',
				catalog_state: 'available',
				providers: [
					{
						provider: 'tencent_tms',
						available: true,
						configured: true,
						active: true,
					},
				],
			},
		],
		billing_currency: null,
		realtime_supported: true,
		limits: {
			runtime: 'node',
			json_body_bytes: 2 * 1024 * 1024,
			image_file_bytes: 20 * 1024 * 1024,
			image_count: 5,
			image_total_bytes: 100 * 1024 * 1024,
			audio_file_bytes: 25 * 1024 * 1024,
			multipart_body_bytes: 104 * 1024 * 1024,
		},
		billing: 'none',
		request_logs: false,
		failover: false,
	}
}
