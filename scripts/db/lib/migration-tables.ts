export const ETL_TABLE_ORDER = [
	'users',
	'oauth_apps',
	'oauth_clients',
	'oauth_access_tokens',
	'organizations',
	'organization_memberships',
	'workspaces',
	'workspace_memberships',
	'workspace_budgets',
	'identity_event_inbox',
	'api_keys',
	'management_api_keys',
	'byok_keys',
	'batches',
	'batch_items',
	'request_presets',
	'request_preset_versions',
	'guardrails',
	'guardrail_versions',
	'guardrail_assignments',
	'providers',
	'models',
	'model_tags',
	'model_endpoints',
	'route_pools',
	'model_surfaces',
	'model_routes',
	'model_endpoint_routes',
	'route_data_policies',
	'route_data_policy_audit',
	'route_pool_sticky_bindings',
	'api_key_request_logs',
	'provider_attempt_availability',
	'generation_feedback',
	'guardrail_budget_windows',
	'guardrail_budget_reservations',
	'user_budget_reservations',
	'public_model_daily_stats',
	'system_config',
	'config_change_audit',
	'config_group_audit',
	'mcp_servers',
	'mcp_server_items',
	'user_audit_logs',
	'admin_api_keys',
	'admin_access_key_audit',
	'shared_keys',
	'admin_shared_key_audit',
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
	mcp_servers: ['id'],
	mcp_server_items: ['id'],
	oauth_apps: ['id'],
	oauth_clients: ['client_id'],
	oauth_access_tokens: ['id'],
	organizations: ['id'],
	organization_memberships: ['organization_id', 'subject'],
	workspaces: ['id'],
	workspace_memberships: ['id'],
	workspace_budgets: ['id'],
	identity_event_inbox: ['source', 'event_id'],
	api_keys: ['id'],
	management_api_keys: ['id'],
	byok_keys: ['id'],
	batches: ['id'],
	batch_items: ['batch_id', 'ordinal'],
	request_presets: ['id'],
	request_preset_versions: ['id'],
	guardrails: ['id'],
	guardrail_versions: ['id'],
	guardrail_assignments: ['id'],
	providers: ['id'],
	models: ['id'],
	model_tags: ['model_id', 'tag'],
	model_endpoints: ['id'],
	route_pools: ['id'],
	model_surfaces: ['id'],
	model_routes: ['id'],
	model_endpoint_routes: ['endpoint_id', 'route_target_id'],
	route_data_policies: ['route_target_id'],
	route_data_policy_audit: ['id'],
	route_pool_sticky_bindings: ['route_pool_id', 'affinity_hash'],
	api_key_request_logs: ['id'],
	provider_attempt_availability: ['request_log_id', 'attempt_index'],
	generation_feedback: ['id'],
	guardrail_budget_windows: ['workspace_id', 'scope_type', 'scope_id', 'period', 'period_start'],
	guardrail_budget_reservations: ['id'],
	user_budget_reservations: ['request_id'],
	public_model_daily_stats: ['stat_date', 'model_id', 'shard'],
	system_config: ['key'],
	config_change_audit: ['id'],
	config_group_audit: ['id'],
	user_audit_logs: ['id'],
	admin_api_keys: ['id'],
	admin_access_key_audit: ['id'],
	shared_keys: ['id'],
	admin_shared_key_audit: ['id'],
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

/** Seeded by target migrations; D1 has no mutex table to copy or truncate. */
export const ETL_TARGET_ONLY_TABLES = [
	'system_config_write_mutex',
	'request_dispatch_intents',
	'request_usage_settlements',
	'request_usage_settlement_outbox',
	'request_usage_recovery_jobs',
	'request_usage_commit_receipts',
] as const;
/** SQLite's immutable earning trigger anchor has no PostgreSQL table equivalent. */
export const ETL_SOURCE_ONLY_TABLES = ['shared_key_earning_history_anchors'] as const;

/** SQLite persists booleans as 0/1 while PostgreSQL requires true/false. */
export const TABLE_BOOLEAN_COLUMNS: Partial<Record<EtlTableName, readonly string[]>> = {
	api_keys: ['include_byok_in_limit'],
	byok_keys: [
		'disabled',
		'is_fallback',
		'always_use_for_provider',
		'always_use_for_matching_models',
	],
	workspaces: ['is_default'],
	model_endpoints: ['supports_implicit_caching', 'supports_voice_cloning'],
	route_pools: ['sticky_enabled'],
	route_data_policies: ['training_allowed', 'zdr_supported'],
};

/**
 * D1 → Postgres ETL / 对账的表注册表（单一来源）。
 *
 * 新增迁移建表时，必须在这里登记：要么加入 `ETL_TABLES`（参与迁移），要么加入
 * `ETL_EXCLUDED_TABLES`（明确不迁并写明原因）。`migration-tables.test.ts` 会比对
 * `packages/core/migrations-*` 实际建出的表，漏登记 CI 直接失败。
 */

/** 与 `packages/core/src/storage/drizzle/client-postgres.ts` 的 GATEWAY_POSTGRES_SEARCH_PATH 保持一致（测试会校验）。 */
export const GATEWAY_POSTGRES_SEARCH_PATH = 'cinatoken_gateway, public';

/**
 * 按"谁会改它"分三组，决定切换时在哪个阶段同步：
 *
 * - `config`：只有管理员（Admin）会写。Proxy 请求路径不写，预热时同步一次，
 *   维护窗口内用 `--check` 校验没有漂移即可（有漂移再 `--kind=config --prune` 补一次）。
 * - `state`：会被请求或维护开关改写，窗口内必须在冻结之后再同步（带 `--prune`）。
 *   `users`（预算/钱包）、`api_keys`（last_used_at）、`oauth_access_tokens`（刷新轮换）、`route_pool_sticky_bindings`（Proxy 每次请求都写）。
 *   `system_config` 是特例：只有 Admin 写，但维护模式开关本身就存在这里，
 *   新环境要继承“冻结”状态，所以必须在冻结之后同步。
 * - `log`：只追加的日志，体量大，预热时同步，窗口内只补尾部（`--since`）。
 */
export type EtlTableKind = 'config' | 'state' | 'log';

export const ETL_TABLE_KINDS: readonly EtlTableKind[] = ['config', 'state', 'log'];

/** 解析 `--kind`：`all`、单个值或逗号分隔（如 `state,log`）。写错直接报错，不退化成全量。 */
export function parseKinds(raw: string | undefined): Set<EtlTableKind> {
	const text = (raw ?? 'all').trim();
	if (text === 'all') {
		return new Set(ETL_TABLE_KINDS);
	}
	const kinds = new Set<EtlTableKind>();
	for (const item of text.split(',').map((entry) => entry.trim())) {
		if (!(ETL_TABLE_KINDS as readonly string[]).includes(item)) {
			throw new Error(
				`Invalid --kind "${item}", expected all or a comma list of ${ETL_TABLE_KINDS.join('|')}`,
			);
		}
		kinds.add(item as EtlTableKind);
	}
	if (kinds.size === 0) {
		throw new Error('Invalid --kind: empty');
	}
	return kinds;
}

export interface EtlTableSpec {
	readonly name: string;
	readonly kind: EtlTableKind;
	/** `ON CONFLICT` 键，保证 ETL 可重复执行。 */
	readonly conflictKeys: readonly string[];
	/**
	 * 设置后按该列 keyset 分页（`WHERE col > last ORDER BY col`），否则按 `rowid` + OFFSET。
	 * 大表必须设置，OFFSET 会随偏移量线性变慢。该列须唯一且非空。
	 */
	readonly keysetColumn?: string;
	/** `--since` 过滤所用的时间列（仅 `log` 表）。 */
	readonly sinceColumn?: string;
	/**
	 * D1 里 `sinceColumn` 上的索引名。设置后 `--since` 的分页查询强制走它（`INDEXED BY`）。
	 * 不加的话 SQLite 为了满足 `ORDER BY id LIMIT` 会顺着主键全表扫描：
	 * 线上 85 万行请求日志补 2000 行尾部要 10 到 39 秒，走索引只要几毫秒。
	 * 索引不存在时 D1 会直接报错（不会静默变慢），测试也会核对迁移里确实建了这个索引。
	 */
	readonly sinceIndex?: string;
	/**
	 * `--check` 比较时忽略的列：运行中会被请求不断改写、与业务内容无关的使用时间戳。
	 * 只影响校验；同步（upsert）仍会照常复制这些列。
	 */
	readonly checkIgnoreColumns?: readonly string[];
}

/**
 * 顺序即写入顺序，必须满足外键依赖（被引用表在前）。
 * 测试会从迁移脚本里解析 `REFERENCES` 校验这一点。
 */
const UPSTREAM_ETL_TABLES = [
	{ name: 'users', kind: 'state', conflictKeys: ['id'] },
	{ name: 'api_keys', kind: 'state', conflictKeys: ['id'] },
	// 访问令牌随授权 / 刷新改写；last_used_at 随每次 MCP 调用改写，不参与一致性校验。
	{ name: 'oauth_access_tokens', kind: 'state', conflictKeys: ['id'], checkIgnoreColumns: ['last_used_at'] },
	// 内置 OAuth：应用目录只有管理员写；动态注册实例由客户端注册请求写入，last_authorized_at 随授权改写，不参与一致性校验。
	{ name: 'oauth_apps', kind: 'config', conflictKeys: ['id'] },
	{
		name: 'oauth_clients',
		kind: 'state',
		conflictKeys: ['client_id'],
		checkIgnoreColumns: ['last_authorized_at'],
	},
	{ name: 'providers', kind: 'config', conflictKeys: ['id'] },
	{ name: 'models', kind: 'config', conflictKeys: ['id'] },
	{ name: 'model_tags', kind: 'config', conflictKeys: ['model_id', 'tag'] },
	{ name: 'route_pools', kind: 'config', conflictKeys: ['id'] },
	{ name: 'model_routes', kind: 'config', conflictKeys: ['id'] },
	{ name: 'model_surfaces', kind: 'config', conflictKeys: ['id'] },
	{ name: 'route_pool_sticky_bindings', kind: 'state', conflictKeys: ['route_pool_id', 'affinity_hash'] },
	{ name: 'mcp_servers', kind: 'config', conflictKeys: ['id'] },
	{ name: 'mcp_server_items', kind: 'config', conflictKeys: ['id'] },
	{ name: 'system_config', kind: 'state', conflictKeys: ['key'] },
	// last_used_at 在每次调用 Admin API 时被改写（维护窗口里读接口仍放行），不能参与一致性校验。
	{ name: 'admin_api_keys', kind: 'config', conflictKeys: ['id'], checkIgnoreColumns: ['last_used_at'] },
	{
		name: 'api_key_request_logs',
		kind: 'log',
		conflictKeys: ['id'],
		keysetColumn: 'id',
		sinceColumn: 'created_at',
		sinceIndex: 'idx_api_key_request_logs_created',
	},
	{
		name: 'user_audit_logs',
		kind: 'log',
		conflictKeys: ['id'],
		keysetColumn: 'id',
		sinceColumn: 'created_at',
	},
] as const satisfies readonly EtlTableSpec[];

/** 明确不迁移的表及原因。 */
export const ETL_EXCLUDED_TABLES: Readonly<Record<string, string>> = {
	admin_sessions: '后台登录会话，到新环境让管理员重新登录即可',
	model_endpoint_backfill_database_identity: '数据库本地信任身份，目标必须单独建立，不能复制源库身份',
	model_endpoint_backfill_trust_registry: '端点信任根绑定目标数据库，需要单独核验',
	model_endpoint_backfill_runs: '目标本地端点验证执行记录，不能作为跨库验证证据',
	model_endpoint_evidence_attestations: '目标本地不可变验证证明，不能跨数据库制造信任',
	shared_key_earning_history_anchors:
		'D1 不可变收益触发器锚点；Postgres 由目标原生迁移建立历史约束，收益账本仍全量迁移并对账',
	system_config_write_mutex: 'Postgres 迁移预置的永久配置写互斥行，不复制或清空',
	request_dispatch_intents: 'Postgres 恢复状态，通用 ETL 不迁移；启用恢复功能前需独立停写、排空与核验',
	request_usage_settlements: 'Postgres 恢复计费事实，不能用通用 ETL 重放',
	request_usage_settlement_outbox: 'Postgres 恢复交付状态，不能用通用 ETL 重放',
	request_usage_recovery_jobs: 'Postgres 恢复租约状态，不能跨库复制后继续执行',
	request_usage_commit_receipts: 'Postgres 恢复提交收据，需要与恢复事实使用同一专用切换流程',
	oauth_authorization_requests:
		'授权请求与一次性授权码，10 分钟内过期；切换时未完成的授权让客户端重新发起即可',
};

/** 迁移工具自己的元数据表，不属于业务表（测试解析时忽略）。 */
export const MIGRATION_META_TABLES: readonly string[] = ['d1_migrations', 'schema_migrations'];

export function getEtlTableSpec(name: string): EtlTableSpec {
	const spec = (ETL_TABLES as readonly EtlTableSpec[]).find((table) => table.name === name);
	if (!spec) {
		throw new Error(`Unknown ETL table: ${name}`);
	}
	return spec;
}

const upstreamTableSpecs = new Map<string, EtlTableSpec>(
	UPSTREAM_ETL_TABLES.map((spec) => [spec.name, spec]),
);
export const ETL_TABLES: readonly EtlTableSpec[] = ETL_TABLE_ORDER.map(
	(name) =>
		upstreamTableSpecs.get(name) ?? {
			name,
			kind: name.endsWith('_audit') || name.endsWith('_logs') ? 'log' : 'state',
			conflictKeys: TABLE_CONFLICT_KEYS[name],
			...(name.endsWith('_audit') || name.endsWith('_logs')
				? { keysetColumn: 'id', sinceColumn: 'created_at' }
				: {}),
		},
);
for (const table of ETL_EXCLUDED_SESSION_TABLES)
	if (!(table in ETL_EXCLUDED_TABLES))
		(ETL_EXCLUDED_TABLES as Record<string, string>)[table] =
			'CinaToken transient session/authorization state';
