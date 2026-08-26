export const ETL_TABLE_ORDER = [
	'users',
	'api_keys',
	'providers',
	'models',
	'model_tags',
	'route_pools',
	'model_surfaces',
	'model_routes',
	'route_pool_sticky_bindings',
	'api_key_request_logs',
	'system_config',
	'user_audit_logs',
	'admin_api_keys',
	'shared_keys',
	'user_earnings',
	'shared_key_earnings',
	'withdrawals',
	'nft_mints',
	'portal_ledger_entries',
	'chain_job_transactions',
] as const;

export type EtlTableName = (typeof ETL_TABLE_ORDER)[number];

export const ETL_TABLES_TO_TRUNCATE = [...ETL_TABLE_ORDER].reverse();

export const TABLE_CONFLICT_KEYS: Record<EtlTableName, string[]> = {
	users: ['id'],
	api_keys: ['id'],
	providers: ['id'],
	models: ['id'],
	model_tags: ['model_id', 'tag'],
	route_pools: ['id'],
	model_surfaces: ['id'],
	model_routes: ['id'],
	route_pool_sticky_bindings: ['route_pool_id', 'affinity_hash'],
	api_key_request_logs: ['id'],
	system_config: ['key'],
	user_audit_logs: ['id'],
	admin_api_keys: ['id'],
	shared_keys: ['id'],
	user_earnings: ['user_id'],
	shared_key_earnings: ['id'],
	withdrawals: ['id'],
	nft_mints: ['id'],
	portal_ledger_entries: ['id'],
	chain_job_transactions: ['job_kind', 'job_id'],
};

/**
 * Sessions intentionally do not cross the database boundary. A cutover must
 * force both users and administrators to authenticate against the new primary.
 */
export const ETL_EXCLUDED_SESSION_TABLES = ['portal_sessions', 'admin_sessions'] as const;

/** SQLite persists booleans as 0/1 while PostgreSQL requires true/false. */
export const TABLE_BOOLEAN_COLUMNS: Partial<Record<EtlTableName, readonly string[]>> = {
	route_pools: ['sticky_enabled'],
};
