/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { ModelSyncReport } from '../model-contracts'

export const modelSyncFixture: ModelSyncReport = {
	billing_currency: 'USD',
	models_with_diff: 3,
	groups: [
		{
			vendor: 'openai',
			vendor_label: 'OpenAI',
			models: [
				{
					model_id: 'openai/text',
					display_name: 'Text model',
					kind: 'llm',
					routes_count: 2,
					active_routes_count: 1,
					fields: [
						{
							key: 'display_name',
							status: 'changed',
							current: 'Local text',
							official: 'Official text',
							default_apply: true,
						},
						{
							key: 'description',
							status: 'added',
							current: null,
							official: '<script>safe text</script>',
							default_apply: true,
						},
						{
							key: 'pricing_profile',
							status: 'changed',
							default_apply: false,
							rows: [
								{
									path: 'tiers[0].input_price',
									status: 'changed',
									current: '2',
									official: '1',
								},
								{
									path: 'schedule.windows[0].name',
									status: 'removed',
									current: 'night',
									official: null,
								},
							],
						},
					],
				},
				{
					model_id: 'openai/image',
					display_name: null,
					kind: 'image',
					routes_count: 0,
					active_routes_count: 0,
					fields: [
						{
							key: 'max_tokens',
							status: 'added',
							current: null,
							official: '8192',
							default_apply: true,
						},
					],
				},
			],
		},
		{
			vendor: 'alibaba',
			vendor_label: 'Alibaba',
			models: [
				{
					model_id: 'alibaba/speech',
					display_name: 'Speech model',
					kind: 'audio',
					routes_count: 1,
					active_routes_count: 0,
					fields: [
						{
							key: 'vendor',
							status: 'changed',
							current: 'other',
							official: 'alibaba',
							default_apply: true,
						},
					],
				},
			],
		},
	],
}
