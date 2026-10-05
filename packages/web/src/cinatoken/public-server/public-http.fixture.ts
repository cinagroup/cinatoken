/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
export const PUBLIC_HTTP_FIXTURE_MODEL = {
	id: 'vendor/http-fixture',
	slug: 'http-fixture',
	display_name: 'HTTP authority model',
	vendor: 'Vendor',
	context_window: 128_000,
	max_tokens: 32_000,
	pricing_profile: {
		tiers: [
			{
				upto: null,
				label: null,
				input_price: -0.000001,
				output_price: 0,
				cache_read_price: 0.0000001,
				cache_write_price: null,
				image_input_price: null,
				image_input_cache_price: null,
				image_output_price: null,
			},
		],
	},
	tags: ['http-proof'],
	route_groups: ['default'],
	protocols: ['openai'],
	protocols_by_group: { default: ['openai'] },
	recommended_protocol: 'openai',
	description:
		'HTTP authority description </script><script>unsafe-marker</script>',
	input_modalities: ['text'],
	output_modalities: ['text'],
	released_at: null,
	endpoint_slugs: [],
	regions: [],
	data_policy_summary: {
		verified_route_count: 0,
		zdr_available: false,
		latest_verified_at: null,
	},
}

/** Local HTTP contract data only. Never used by the product or a live upstream. */
export function publicCatalogHttpFixture(
	path: string,
	label = 'HTTP authority model',
	currency = 'SGD'
): unknown {
	const generatedAt = '2026-10-02T00:00:00.000Z'
	const row = { ...PUBLIC_HTTP_FIXTURE_MODEL, display_name: label }
	if (path.includes('/catalog/model/'))
		return {
			object: 'model',
			data: row,
			billing_currency: currency,
			generated_at: generatedAt,
		}
	if (path.includes('/catalog/providers'))
		return {
			object: 'list',
			data: [
				{
					id: 'Vendor',
					display_name: 'HTTP authority provider',
					model_count: 1,
					protocols: ['openai'],
					route_groups: ['default'],
					input_modalities: ['text'],
					output_modalities: ['text'],
					latest_released_at: null,
				},
			],
			billing_currency: currency,
			generated_at: generatedAt,
		}
	if (path.includes('/catalog/stats/')) {
		const range =
			new URL(path, 'https://fixture.invalid').searchParams.get('range') ?? '7d'
		let days = 7
		if (range === '90d') days = 90
		else if (range === '30d') days = 30
		const start = new Date(generatedAt)
		start.setUTCDate(start.getUTCDate() - days + 1)
		return {
			object: 'list',
			data: [
				{
					id: row.id,
					slug: row.slug,
					display_name: label,
					vendor: row.vendor,
					request_count: 20,
					success_rate: 100,
					avg_latency_ms: 25,
					output_tokens: 10,
					total_tokens: 30,
				},
			],
			range,
			window_start: start.toISOString(),
			window_end: generatedAt,
			minimum_sample_size: 20,
			generated_at: generatedAt,
		}
	}
	return {
		object: 'list',
		data: [row],
		billing_currency: currency,
		generated_at: generatedAt,
	}
}
