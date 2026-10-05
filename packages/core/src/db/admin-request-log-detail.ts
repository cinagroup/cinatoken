/**
 * Bounded Admin detail projection. This deliberately does not load raw JSON,
 * credential labels/fingerprints, error text, bodies, or transport headers.
 * Required raw RequestLogRow fields are null because this reader omits them;
 * callers must still apply their public response whitelist.
 */
export function adminRequestLogDetailSql(driver: 'd1' | 'mysql' | 'postgres'): string {
	const timestamp = driver === 'postgres'
		? `to_char(rl.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
		: 'rl.created_at';
	const marker = driver === 'postgres' ? '$1' : '?';
	return `SELECT rl.id, rl.user_id, rl.workspace_id, rl.api_key_id, rl.user_email,
		rl.model_id, rl.provider_id, rl.provider_model_name, rl.model_name, rl.provider_name,
		rl.request_protocol, rl.request_operation, rl.upstream_protocol, rl.upstream_operation,
		rl.model_surface_id, rl.route_pool_id, rl.route_target_id, rl.adapter,
		rl.input_tokens, rl.output_tokens, rl.cache_read_tokens, rl.cache_write_tokens,
		rl.reasoning_tokens, rl.total_tokens, rl.metered_cost, rl.standard_cost, rl.charged_cost,
		rl.route_group, rl.status, rl.latency_ms, rl.gateway_overhead_ms, rl.upstream_response_ms,
		rl.final_upstream_headers_ms, rl.first_reasoning_token_ms, rl.first_token_ms, rl.stream_duration_ms,
		rl.upstream_attempt_count, rl.upstream_failover_count, rl.provider_key_id,
		rl.upstream_request_id, rl.upstream_message_id, rl.billing_kind,
		rl.input_image_count, rl.output_image_count, rl.audio_duration_seconds, rl.audio_characters,
		NULL AS request_body, NULL AS upstream_request_body, NULL AS route_trace,
		NULL AS timing_metadata, NULL AS error_message, NULL AS raw_usage, NULL AS pricing_audit,
		NULL AS provider_key_label, NULL AS provider_key_fingerprint,
		${timestamp} AS created_at
		FROM api_key_request_logs rl WHERE rl.id = ${marker} LIMIT 1`;
}
