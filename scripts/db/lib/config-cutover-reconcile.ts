export const CONFIG_CUTOVER_RECONCILE_BATCH_SIZE = 250;
export const CONFIG_CUTOVER_D1_MIGRATION = '0076_tools_config_group_audit.sql';
export const CONFIG_CUTOVER_POSTGRES_MIGRATION = '0081_tools_config_group_audit.sql';
export const CONFIG_CUTOVER_TARGET_COLUMN_QUERY = `SELECT table_name, column_name
	FROM information_schema.columns
	WHERE table_schema = $1 AND table_name IN ('system_config', 'config_change_audit', 'admin_access_key_audit', 'admin_shared_key_audit', 'config_group_audit')`;

export const CONFIG_CUTOVER_RECONCILE_SPECS = [
	{ table: 'system_config', identity: 'key', columns: ['key', 'value', 'revision'] },
	{
		table: 'config_change_audit',
		identity: 'id',
		columns: ['id', 'config_key', 'channel', 'action', 'actor_kind', 'actor_id', 'outcome', 'created_at'],
	},
	{
		table: 'admin_access_key_audit', identity: 'id',
		columns: ['id', 'key_id', 'action', 'change_mask', 'actor_kind', 'actor_id', 'before_permissions_json',
			'after_permissions_json', 'before_status', 'after_status', 'created_at'],
	},
	{
		table: 'admin_shared_key_audit', identity: 'id',
		columns: ['id', 'key_id', 'action', 'change_mask', 'actor_kind', 'actor_id', 'source', 'reason',
			'before_status', 'before_seller_priority', 'before_weight', 'before_validated',
			'after_status', 'after_seller_priority', 'after_weight', 'after_validated',
			'before_revision', 'after_revision', 'created_at'],
	},
	{
		table: 'config_group_audit', identity: 'id',
		columns: ['id', 'family', 'provider', 'action', 'actor_kind', 'actor_id', 'reason',
			'changed_fields_json', 'active_before', 'active_after', 'credentials_json',
			'revision_before_json', 'revision_after_json', 'source', 'created_at'],
	},
] as const;

export type ConfigCutoverReconcileSpec = (typeof CONFIG_CUTOVER_RECONCILE_SPECS)[number];

export function configCutoverCheckLabel(spec: ConfigCutoverReconcileSpec): string {
	return `${spec.table}:${spec.table === 'system_config' ? 'value_revision_exact' : 'metadata_exact'}`;
}

export function missingConfigCutoverTargetTables(
	columns: readonly { table_name: string; column_name: string }[],
): string[] {
	const available = new Set(columns.map((column) => `${column.table_name}.${column.column_name}`));
	return CONFIG_CUTOVER_RECONCILE_SPECS
		.filter((spec) => spec.columns.some((column) => !available.has(`${spec.table}.${column}`)))
		.map((spec) => spec.table);
}

export function configCutoverRowId(row: Record<string, unknown>, spec: ConfigCutoverReconcileSpec): string {
	const id = row[spec.identity];
	if (typeof id !== 'string' || id.length === 0) {
		throw new Error(`invalid_config_cutover_identity:${spec.table}`);
	}
	return id;
}

export function configCutoverTargetColumns(
	spec: ConfigCutoverReconcileSpec,
	quoteIdentifier: (value: string) => string,
): string {
	return spec.columns.map((column) => column === 'created_at'
		? `to_char(${quoteIdentifier(column)} AT TIME ZONE 'UTC', ` +
			`'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${quoteIdentifier(column)}`
		: quoteIdentifier(column)).join(', ');
}

function comparableValue(column: string, value: unknown): string | null | undefined {
	if (column === 'created_at') {
		if (!(value instanceof Date || typeof value === 'string')) {
			throw new Error('invalid_config_cutover_timestamp');
		}
		if (typeof value === 'string' &&
			!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
			throw new Error('invalid_config_cutover_timestamp');
		}
		const timestamp = new Date(value);
		if (Number.isFinite(timestamp.getTime())) {
			const iso = timestamp.toISOString();
			const fractional = typeof value === 'string'
				? /\.(\d{1,6})(?:Z|[+-]\d{2}:?\d{2})$/u.exec(value)?.[1]
				: undefined;
			const micros = fractional?.padEnd(6, '0') ?? `${iso.slice(20, 23)}000`;
			return `${iso.slice(0, 19)}.${micros}Z`;
		}
		throw new Error('invalid_config_cutover_timestamp');
	}
	if (value === null || value === undefined) return value;
	return String(value);
}

/** Compare values only in memory; callers report mismatch counts, never configuration values. */
export function countConfigCutoverBatchMismatches(
	spec: ConfigCutoverReconcileSpec,
	sourceRows: readonly Record<string, unknown>[],
	targetRows: readonly Record<string, unknown>[],
): number {
	const targetById = new Map<string, Record<string, unknown>>();
	for (const row of targetRows) {
		const id = configCutoverRowId(row, spec);
		if (targetById.has(id)) throw new Error(`duplicate_config_cutover_target_identity:${spec.table}`);
		targetById.set(id, row);
	}
	let mismatches = 0;
	for (const source of sourceRows) {
		const id = configCutoverRowId(source, spec);
		const target = targetById.get(id);
		if (!target || spec.columns.some((column) =>
			comparableValue(column, source[column]) !== comparableValue(column, target[column])
		)) mismatches += 1;
	}
	return mismatches;
}
