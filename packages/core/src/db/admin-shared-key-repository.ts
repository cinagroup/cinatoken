import type { D1DatabaseClient, MySqlDatabaseClient, PostgresDatabaseClient } from '../storage/database-client';
import { asMySqlPool } from './mysql/mysql2-compat';
import { SHARED_KEY_STATE_COLUMNS, sharedKeyMySqlInstant, sharedKeyStateValues } from './shared-key-state';
import { sharedKeyStateExpectation, type SharedKeyRow, type SharedKeyStatus } from './shared-keys-types';
import {
	assertAdminSharedKeyAuditPage, assertAdminSharedKeyList, assertAdminSharedKeyMutation, assertAdminSharedKeyId,
	matchesAdminSharedKeyProfile, sharedKeyAdminAuditReason, sharedKeyAdminRevision,
	type AdminSharedKeyAuditRow, type AdminSharedKeyDelete, type AdminSharedKeyListOptions,
	type AdminSharedKeyUpdate, type AdminSharedKeysRepository, type AdminSharedKeyMutationOutcome,
} from './admin-shared-key-governance';

type Driver = 'd1' | 'mysql' | 'postgres';
type Value = string | number | null;
type SqlRow = Record<string, string | number | null>;
interface Executor { read(sql: string, values: Value[]): Promise<SqlRow[]>; write(sql: string, values: Value[]): Promise<number> }
const columns = ['id', 'seller_user_id', 'channel_type', 'api_key', 'key_fingerprint', 'label', 'status', 'seller_priority', 'weight',
	'input_price', 'output_price', 'cache_read_price', 'cache_write_price', 'validated_at', 'last_used_at', 'last_failure_at', 'failure_reason',
	'served_input_tokens', 'served_output_tokens', 'earned_total', 'created_at', 'updated_at'];
const auditColumns = ['id', 'key_id', 'action', 'change_mask', 'actor_kind', 'actor_id', 'source', 'reason',
	'before_status', 'before_seller_priority', 'before_weight', 'before_validated', 'after_status', 'after_seller_priority', 'after_weight', 'after_validated',
	'before_revision', 'after_revision', 'created_at'];
const table = (driver: Driver, name: string) => driver === 'postgres' ? `cinatoken_gateway.${name}` : name;
function placeholders(driver: Driver, sql: string): string { let index = 0; return driver === 'postgres' ? sql.replaceAll('?', () => `$${++index}`) : sql; }
function selectedColumns(driver: Driver, names: string[]): string {
	return names.map(name => name.endsWith('_at') ? driver === 'postgres'
		? `to_char(${name} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${name}`
		: driver === 'mysql' ? `DATE_FORMAT(${name}, '%Y-%m-%dT%H:%i:%s.%fZ') AS ${name}` : name : name).join(', ');
}
function mapKey(row: SqlRow): SharedKeyRow {
	return { id: String(row.id), sellerUserId: String(row.seller_user_id), channelType: String(row.channel_type), apiKey: String(row.api_key),
		keyFingerprint: String(row.key_fingerprint), label: row.label as string | null, status: String(row.status),
		sellerPriority: Number(row.seller_priority), weight: Number(row.weight), inputPrice: Number(row.input_price), outputPrice: Number(row.output_price),
		cacheReadPrice: row.cache_read_price === null ? null : Number(row.cache_read_price), cacheWritePrice: row.cache_write_price === null ? null : Number(row.cache_write_price),
		validatedAt: row.validated_at as string | null, lastUsedAt: row.last_used_at as string | null, lastFailureAt: row.last_failure_at as string | null,
		failureReason: row.failure_reason as string | null, servedInputTokens: Number(row.served_input_tokens), servedOutputTokens: Number(row.served_output_tokens),
		earnedTotal: Number(row.earned_total), earnedTotalExact: String(row.earned_total), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}
function filters(options: AdminSharedKeyListOptions): { where: string; values: Value[] } {
	const parts: string[] = []; const values: Value[] = [];
	for (const [column, value] of [['status', options.status], ['channel_type', options.channelType], ['seller_user_id', options.sellerUserId]] as const) {
		if (value !== undefined) { parts.push(`${column} = ?`); values.push(value); }
	}
	if (options.search !== undefined) {
		// Use a non-backslash escape character, independent of MySQL sql_mode.
		const term = `%${options.search.replace(/[!%_]/gu, value => `!${value}`)}%`;
		parts.push("(id LIKE ? ESCAPE '!' OR label LIKE ? ESCAPE '!')"); values.push(term, term);
	}
	return { where: parts.length ? ` WHERE ${parts.join(' AND ')}` : '', values };
}
function expectation(driver: Driver, input: AdminSharedKeyDelete): { condition: string; values: Value[] } {
	const values = sharedKeyStateValues(input.expected);
	if (driver === 'mysql' && input.expected.validatedAt !== null) values[4] = sharedKeyMySqlInstant(input.expected.validatedAt);
	const operator = driver === 'd1' ? 'IS' : driver === 'mysql' ? '<=>' : 'IS NOT DISTINCT FROM';
	return { condition: `id = ? AND ${SHARED_KEY_STATE_COLUMNS.map(column => `${column} ${operator} ?`).join(' AND ')}`, values: [input.id, ...values] };
}
function changed(input: AdminSharedKeyUpdate): boolean {
	return Object.entries(input.patch).some(([key, value]) => value !== input.expected[key as keyof typeof input.patch]);
}
async function auditValues(input: AdminSharedKeyDelete | AdminSharedKeyUpdate, before: SharedKeyRow): Promise<Value[]> {
	const patch = 'patch' in input ? input.patch : null;
	const after = patch ? { ...before, ...patch } : null;
	const action = !patch ? 'deleted' : patch.status === 'disabled' && before.status !== 'disabled' ? 'disabled'
		: patch.status === 'paused' ? 'restored' : 'updated';
	const mask = !patch ? 8 : (patch.status !== undefined && patch.status !== before.status ? 1 : 0)
		| (patch.sellerPriority !== undefined && patch.sellerPriority !== before.sellerPriority ? 2 : 0)
		| (patch.weight !== undefined && patch.weight !== before.weight ? 4 : 0);
	return [input.audit.auditId, input.id, action, mask, input.audit.actorKind, input.audit.actorId, input.audit.source,
		sharedKeyAdminAuditReason(input.audit.reason, before), before.status, before.sellerPriority, before.weight, before.validatedAt === null ? 0 : 1,
		after?.status ?? null, after?.sellerPriority ?? null, after?.weight ?? null, after === null ? null : after.validatedAt === null ? 0 : 1,
		await sharedKeyAdminRevision(input.id, sharedKeyStateExpectation(before)), after === null ? null : await sharedKeyAdminRevision(input.id, sharedKeyStateExpectation(after)),
		input.audit.nowIso];
}
function writeSql(driver: Driver, input: AdminSharedKeyDelete | AdminSharedKeyUpdate, gate = ''): { sql: string; values: Value[] } {
	const cas = expectation(driver, input); const values: Value[] = [];
	let sql: string;
	if ('patch' in input) {
		const sets: string[] = [];
		for (const [field, column] of [['status', 'status'], ['sellerPriority', 'seller_priority'], ['weight', 'weight']] as const) {
			if (input.patch[field] !== undefined) { sets.push(`${column} = ?`); values.push(input.patch[field]!); }
		}
		sets.push('updated_at = ?'); values.push(driver === 'mysql' ? sharedKeyMySqlInstant(input.audit.nowIso) : input.audit.nowIso);
		sql = `UPDATE ${table(driver, 'shared_keys')} SET ${sets.join(', ')} WHERE ${cas.condition}${gate}`;
	} else sql = `DELETE FROM ${table(driver, 'shared_keys')} WHERE ${cas.condition}${gate}`;
	values.push(...cas.values);
	if (gate) values.push(input.audit.auditId, input.id);
	return { sql: placeholders(driver, sql) + (driver === 'postgres' ? ' RETURNING id' : ''), values };
}
function common(driver: Driver, executor: Executor): Pick<AdminSharedKeysRepository, 'getAdminSharedKeyById' | 'listAdminSharedKeys' | 'listSharedKeyAdminAudit'> {
	return {
		async getAdminSharedKeyById(id) { assertAdminSharedKeyId(id); return readKey(driver, executor, id); },
		async listAdminSharedKeys(options) {
			options = { ...options };
			assertAdminSharedKeyList(options); const { where, values } = filters(options);
			const count = await executor.read(placeholders(driver, `SELECT COUNT(*) AS total FROM ${table(driver, 'shared_keys')}${where}`), values);
			const rows = await executor.read(placeholders(driver, `SELECT ${selectedColumns(driver, columns)} FROM ${table(driver, 'shared_keys')}${where}
				ORDER BY seller_priority DESC, weight DESC, id ASC LIMIT ${options.pageSize} OFFSET ${(options.page - 1) * options.pageSize}`), values);
			return { keys: rows.map(mapKey), total: Number(count[0]?.total ?? 0) };
		},
		async listSharedKeyAdminAudit(id, { limit, before }) {
			assertAdminSharedKeyAuditPage(id, limit, before);
			const condition = before ? ' AND (created_at < ? OR (created_at = ? AND id < ?))' : '';
			const timestamp = before ? driver === 'mysql' ? sharedKeyMySqlInstant(before.createdAt) : before.createdAt : null;
			const rows = await executor.read(placeholders(driver, `SELECT ${selectedColumns(driver, auditColumns)} FROM ${table(driver, 'admin_shared_key_audit')}
				WHERE key_id = ?${condition} ORDER BY admin_shared_key_audit.created_at DESC, id DESC LIMIT ${limit}`), before ? [id, timestamp, timestamp, before.id] : [id]);
			return rows.map(row => ({ id: String(row.id), keyId: String(row.key_id), createdAt: String(row.created_at),
				action: row.action as AdminSharedKeyAuditRow['action'], changeMask: Number(row.change_mask), actorKind: row.actor_kind as AdminSharedKeyAuditRow['actorKind'],
				actorId: String(row.actor_id), source: row.source as AdminSharedKeyAuditRow['source'], reason: String(row.reason),
				before: { status: row.before_status as SharedKeyStatus, sellerPriority: Number(row.before_seller_priority), weight: Number(row.before_weight), validated: Number(row.before_validated) === 1 },
				after: row.after_status === null ? null : { status: row.after_status as SharedKeyStatus, sellerPriority: Number(row.after_seller_priority), weight: Number(row.after_weight), validated: Number(row.after_validated) === 1 },
				beforeRevision: String(row.before_revision), afterRevision: row.after_revision as string | null }));
		},
	};
}
async function readKey(driver: Driver, executor: Executor, id: string, lock = false): Promise<SharedKeyRow | null> {
	const rows = await executor.read(placeholders(driver, `SELECT ${selectedColumns(driver, columns)} FROM ${table(driver, 'shared_keys')} WHERE id = ?${lock ? ' FOR UPDATE' : ''}`), [id]);
	return rows[0] ? mapKey(rows[0]) : null;
}
export function createD1SharedKeyAdminRepository(db: D1DatabaseClient): AdminSharedKeysRepository {
	const raw = db.raw;
	const executor: Executor = {
		async read(sql, values) { return (await raw.prepare(sql).bind(...values).all<SqlRow>()).results ?? []; },
		async write(sql, values) { return Number((await raw.prepare(sql).bind(...values).run()).meta.changes ?? 0); },
	};
	async function mutate(input: AdminSharedKeyDelete | AdminSharedKeyUpdate) {
		input = { ...input, expected: { ...input.expected }, audit: { ...input.audit }, ...('patch' in input ? { patch: { ...input.patch } } : {}) };
		assertAdminSharedKeyMutation(input); const before = await readKey('d1', executor, input.id);
		if (!before) return 'not_found' as const;
		if (!matchesAdminSharedKeyProfile(before, input.expected)) return 'conflict' as const;
		if ('patch' in input && !changed(input)) return 'unchanged' as const;
		const cas = expectation('d1', input); const values = await auditValues(input, before);
		const auditSql = `INSERT INTO admin_shared_key_audit (${auditColumns.join(', ')}) SELECT ${values.map(() => '?').join(', ')} FROM shared_keys WHERE ${cas.condition}`;
		const write = writeSql('d1', input, ' AND EXISTS (SELECT 1 FROM admin_shared_key_audit WHERE id = ? AND key_id = ?)');
		const results = await raw.batch([
			raw.prepare(auditSql).bind(...values, ...cas.values), raw.prepare(write.sql).bind(...write.values),
			raw.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM admin_shared_key_audit WHERE id = ? AND key_id = ?)
				AND changes() != 1 THEN json('admin_shared_key_audit_commit_guard_failure') ELSE 1 END AS audit_commit_guard`).bind(input.audit.auditId, input.id),
		]);
		const audited = Number(results[0]?.meta.changes ?? 0); const written = Number(results[1]?.meta.changes ?? 0);
		if (audited !== written || written > 1 || results.some(result => !result.success)) throw new Error('Shared key audit did not commit');
		if (written === 1) return 'applied' as const;
		const current = await readKey('d1', executor, input.id);
		if (!current) return 'not_found' as const;
		if (matchesAdminSharedKeyProfile(current, input.expected)) throw new Error('Shared key audit did not commit');
		return 'conflict' as const;
	}
	return { ...common('d1', executor),
		async updateSharedKeyAdminWithAudit(input) { if (!input || !Object.hasOwn(input, 'patch')) throw new TypeError('Governance update requires a patch'); return mutate(input); },
		async deleteSharedKeyAdminWithAudit(input) { const result = await mutate({ id: input.id, expected: input.expected, audit: input.audit }); if (result === 'unchanged') throw new Error('Invalid delete outcome'); return result; } };
}
function transactional(driver: 'mysql' | 'postgres', executor: Executor, transaction: (run: (tx: Executor) => Promise<AdminSharedKeyMutationOutcome>) => Promise<AdminSharedKeyMutationOutcome>): AdminSharedKeysRepository {
	async function mutate(input: AdminSharedKeyDelete | AdminSharedKeyUpdate) {
		input = { ...input, expected: { ...input.expected }, audit: { ...input.audit }, ...('patch' in input ? { patch: { ...input.patch } } : {}) };
		assertAdminSharedKeyMutation(input);
		return transaction(async tx => {
			const before = await readKey(driver, tx, input.id, true);
			if (!before) return 'not_found' as const;
			if (!matchesAdminSharedKeyProfile(before, input.expected)) return 'conflict' as const;
			if ('patch' in input && !changed(input)) return 'unchanged' as const;
			const write = writeSql(driver, input);
			if (await tx.write(write.sql, write.values) !== 1) throw new Error('Shared key conditional mutation did not commit');
			const values = await auditValues(input, before); if (driver === 'mysql') values[18] = sharedKeyMySqlInstant(input.audit.nowIso);
			const insert = placeholders(driver, `INSERT INTO ${table(driver, 'admin_shared_key_audit')} (${auditColumns.join(', ')}) VALUES (${values.map(() => '?').join(', ')})`)
				+ (driver === 'postgres' ? ' RETURNING id' : '');
			if (await tx.write(insert, values) !== 1) throw new Error('Shared key audit did not commit');
			return 'applied' as const;
		});
	}
	return { ...common(driver, executor),
		async updateSharedKeyAdminWithAudit(input) { if (!input || !Object.hasOwn(input, 'patch')) throw new TypeError('Governance update requires a patch'); return mutate(input); },
		async deleteSharedKeyAdminWithAudit(input) { const result = await mutate({ id: input.id, expected: input.expected, audit: input.audit }); if (result === 'unchanged') throw new Error('Invalid delete outcome'); return result; } };
}
export function createMySqlSharedKeyAdminRepository(db: MySqlDatabaseClient): AdminSharedKeysRepository {
	const pool = asMySqlPool(db.raw);
	const adapter = (connection: Pick<typeof pool, 'execute'>): Executor => ({
		async read(sql, values) { return (await connection.execute<SqlRow[]>(sql, values))[0]; },
		async write(sql, values) { return (await connection.execute<{ affectedRows: number }>(sql, values))[0].affectedRows; },
	});
	return transactional('mysql', adapter(pool), async run => {
		const connection = await pool.getConnection();
		try { await connection.beginTransaction(); const result = await run(adapter(connection)); await connection.commit(); return result; }
		catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
	});
}
export function createPostgresSharedKeyAdminRepository(db: PostgresDatabaseClient): AdminSharedKeysRepository {
	type Pg = Pick<PostgresDatabaseClient['raw'], 'unsafe'>;
	const adapter = (connection: Pg): Executor => ({
		async read(sql, values) { return connection.unsafe<SqlRow[]>(sql, values); },
		async write(sql, values) { return (await connection.unsafe(sql, values)).length; },
	});
	return transactional('postgres', adapter(db.raw), async run => db.raw.begin(async tx => run(adapter(tx))));
}
