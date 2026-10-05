/**
 * MySQL：`user_audit_logs`。
 */
import { and, count, desc, eq, gte, inArray, lt, lte, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { GlobalUserAuditLogRow, UserAuditLogRow } from '../../types';
import type { MySqlDatabaseClient } from '../../storage/database-client';
import type { GlobalUserAuditLogFilters, UserAuditLogsRepository } from '../../storage/gateway-repository-interfaces';
import {
	userAuditLogsTable as myUserAuditLogsTable,
	usersTable as myUsersTable,
} from '../../storage/drizzle/schema.mysql';
import type { InsertUserAuditLogParams } from '../user-audit-logs-types';
import { toUserAuditLogDrizzleInsert } from '../user-audit-drizzle-insert';
import { deriveUserAuditBudgetFromSnapshots } from '../user-audit-log-derived';
import { normalizeUserAuditActorKinds, userAuditActorKindPrefixRange } from '../user-audit-catalog';
import {
	USER_AUDIT_EXPORT_QUERY_TIMEOUT_MS,
	USER_AUDIT_EXPORT_TEXT_LIMITS as exportLimits,
} from '../user-audit-export-limits';

type MyAuditSelectRow = {
	id: string;
	userId: string | null;
	apiKeyId: string | null;
	eventType: string;
	actorType: string;
	requestLogId: string | null;
	changePayload: string | null;
	beforeUserSnapshot: string | null;
	afterUserSnapshot: string | null;
	changedFields: string | null;
	correlationId: string | null;
	source: string | null;
	actorId: string | null;
	reasonCode: string | null;
	reasonText: string | null;
	createdAt: string;
};

function mapMyAuditRow(r: MyAuditSelectRow): UserAuditLogRow {
	const derived = deriveUserAuditBudgetFromSnapshots(r.beforeUserSnapshot, r.afterUserSnapshot);
	return {
		id: r.id,
		user_id: r.userId,
		api_key_id: r.apiKeyId,
		event_type: r.eventType,
		actor_type: r.actorType,
		before_spent: derived.before_spent,
		delta_spent: derived.delta_spent,
		after_spent: derived.after_spent,
		before_budget_max: derived.before_budget_max,
		after_budget_max: derived.after_budget_max,
		before_budget_base: derived.before_budget_base,
		after_budget_base: derived.after_budget_base,
		request_log_id: r.requestLogId,
		change_payload: r.changePayload,
		before_user_snapshot: r.beforeUserSnapshot ?? null,
		after_user_snapshot: r.afterUserSnapshot ?? null,
		changed_fields: r.changedFields ?? null,
		correlation_id: r.correlationId ?? null,
		source: r.source ?? null,
		actor_id: r.actorId ?? null,
		reason_code: r.reasonCode ?? null,
		reason_text: r.reasonText ?? null,
		created_at: r.createdAt,
	};
}

function globalAuditWhere(options: GlobalUserAuditLogFilters): SQL | undefined {
	const conditions: SQL[] = [];
	if (options.userId) conditions.push(eq(myUserAuditLogsTable.userId, options.userId));
	if (options.apiKeyId) conditions.push(eq(myUserAuditLogsTable.apiKeyId, options.apiKeyId));
	if (options.userEmail) conditions.push(eq(myUsersTable.email, options.userEmail));
	if (options.eventTypes?.length) conditions.push(inArray(myUserAuditLogsTable.eventType, options.eventTypes));
	if (options.actorTypes?.length) conditions.push(inArray(myUserAuditLogsTable.actorType, options.actorTypes));
	if (options.actorId) conditions.push(eq(myUserAuditLogsTable.actorId, options.actorId));
	const actorKinds = normalizeUserAuditActorKinds(options.actorKinds ?? []);
	if (actorKinds.length) {
		conditions.push(or(...actorKinds.map((kind) => {
			const { lower, upper } = userAuditActorKindPrefixRange(kind);
			return and(gte(myUserAuditLogsTable.actorId, lower), lt(myUserAuditLogsTable.actorId, upper));
		}))!);
	}
	if (options.reasonCodes?.length) conditions.push(inArray(myUserAuditLogsTable.reasonCode, options.reasonCodes));
	if (options.sources?.length) conditions.push(inArray(myUserAuditLogsTable.source, options.sources));
	if (options.correlationId) conditions.push(eq(myUserAuditLogsTable.correlationId, options.correlationId));
	// The migration stores UTC wall time in DATETIME(6). Comparing the column
	// directly avoids UNIX_TIMESTAMP's session-time-zone conversion.
	if (options.startDate) conditions.push(gte(myUserAuditLogsTable.createdAt, options.startDate));
	if (options.endDate) conditions.push(options.endDateExclusive
		? lt(myUserAuditLogsTable.createdAt, options.endDate)
		: lte(myUserAuditLogsTable.createdAt, options.endDate));
	return conditions.length ? and(...conditions) : undefined;
}

/** Preserve all six stored microseconds while accepting SQL UTC and ISO-Z cursors. */
function mysqlAuditUtcCursor(value: string): string {
	const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z)?$/u.exec(value);
	if (!match || (value.includes('T') !== Boolean(match[4]))) throw new Error('Invalid MySQL audit UTC cursor');
	const second = `${match[1]}T${match[2]}Z`;
	const instant = new Date(second);
	if (Number.isNaN(instant.getTime()) || instant.toISOString().slice(0, 19) !== second.slice(0, 19)) {
		throw new Error('Invalid MySQL audit UTC cursor');
	}
	return `${match[1]} ${match[2]}.${(match[3] ?? '').padEnd(6, '0')}`;
}

const globalAuditSelectColumns = {
	id: myUserAuditLogsTable.id,
	userId: myUserAuditLogsTable.userId,
	apiKeyId: myUserAuditLogsTable.apiKeyId,
	eventType: myUserAuditLogsTable.eventType,
	actorType: myUserAuditLogsTable.actorType,
	requestLogId: myUserAuditLogsTable.requestLogId,
	changePayload: myUserAuditLogsTable.changePayload,
	beforeUserSnapshot: myUserAuditLogsTable.beforeUserSnapshot,
	afterUserSnapshot: myUserAuditLogsTable.afterUserSnapshot,
	changedFields: myUserAuditLogsTable.changedFields,
	correlationId: myUserAuditLogsTable.correlationId,
	source: myUserAuditLogsTable.source,
	actorId: myUserAuditLogsTable.actorId,
	reasonCode: myUserAuditLogsTable.reasonCode,
	reasonText: myUserAuditLogsTable.reasonText,
	createdAt: myUserAuditLogsTable.createdAt,
	user_email: myUsersTable.email,
};

const exportTextColumns: readonly [SQLWrapper, number][] = [
	[myUserAuditLogsTable.id, exportLimits.id],
	[myUserAuditLogsTable.requestLogId, exportLimits.requestLogId],
	[myUserAuditLogsTable.correlationId, exportLimits.correlationId],
	[myUserAuditLogsTable.eventType, exportLimits.eventType],
	[myUserAuditLogsTable.source, exportLimits.source],
	[myUserAuditLogsTable.reasonCode, exportLimits.reasonCode],
	[myUserAuditLogsTable.reasonText, exportLimits.reasonText],
	[myUserAuditLogsTable.actorType, exportLimits.actorType],
	[myUserAuditLogsTable.actorId, exportLimits.actorId],
	[myUserAuditLogsTable.userId, exportLimits.userId],
	[myUsersTable.email, exportLimits.userEmail],
	[myUserAuditLogsTable.apiKeyId, exportLimits.apiKeyId],
	[myUserAuditLogsTable.beforeUserSnapshot, exportLimits.userSnapshot],
	[myUserAuditLogsTable.afterUserSnapshot, exportLimits.userSnapshot],
];
// The timed export executes through mysql2, bypassing Drizzle's property-name
// mapping. Alias every computed column to the exact key consumed below.
const capped = (column: SQLWrapper, max: number, alias: string) =>
	sql<string | null>`CASE WHEN OCTET_LENGTH(${column}) > ${max} THEN NULL ELSE ${column} END`.as(alias);
const oversized = sql<number>`CASE WHEN ${sql.join(exportTextColumns.map(([column, max]) =>
	sql`OCTET_LENGTH(${column}) > ${max}`
), sql` OR `)} THEN 1 ELSE 0 END`.as('oversized');
const exportSelectColumns = {
	id: capped(myUserAuditLogsTable.id, exportLimits.id, 'id'),
	requestLogId: capped(myUserAuditLogsTable.requestLogId, exportLimits.requestLogId, 'requestLogId'),
	correlationId: capped(myUserAuditLogsTable.correlationId, exportLimits.correlationId, 'correlationId'),
	eventType: capped(myUserAuditLogsTable.eventType, exportLimits.eventType, 'eventType'),
	source: capped(myUserAuditLogsTable.source, exportLimits.source, 'source'),
	reasonCode: capped(myUserAuditLogsTable.reasonCode, exportLimits.reasonCode, 'reasonCode'),
	reasonText: capped(myUserAuditLogsTable.reasonText, exportLimits.reasonText, 'reasonText'),
	actorType: capped(myUserAuditLogsTable.actorType, exportLimits.actorType, 'actorType'),
	actorId: capped(myUserAuditLogsTable.actorId, exportLimits.actorId, 'actorId'),
	userId: capped(myUserAuditLogsTable.userId, exportLimits.userId, 'userId'),
	userEmail: capped(myUsersTable.email, exportLimits.userEmail, 'userEmail'),
	apiKeyId: capped(myUserAuditLogsTable.apiKeyId, exportLimits.apiKeyId, 'apiKeyId'),
	beforeUserSnapshot: capped(myUserAuditLogsTable.beforeUserSnapshot, exportLimits.userSnapshot, 'beforeUserSnapshot'),
	afterUserSnapshot: capped(myUserAuditLogsTable.afterUserSnapshot, exportLimits.userSnapshot, 'afterUserSnapshot'),
	oversized,
	cursorCreatedAt: sql<string>`DATE_FORMAT(${myUserAuditLogsTable.createdAt}, '%Y-%m-%d %H:%i:%s.%f')`.as('cursorCreatedAt'),
};

export function createMySqlUserAuditLogsRepository(db: MySqlDatabaseClient): UserAuditLogsRepository {
	const drizzle = db.drizzle;
	return {
		async insertUserAuditLog(params: InsertUserAuditLogParams): Promise<void> {
			const now = new Date().toISOString();
			await drizzle.insert(myUserAuditLogsTable).values(toUserAuditLogDrizzleInsert(params, now));
		},

		async getUserAuditLogsByUserId(
			userId: string,
			page: number,
			pageSize: number
		): Promise<{ logs: UserAuditLogRow[]; total: number }> {
			const offset = (page - 1) * pageSize;
			const total = Number(
				(
					await drizzle
						.select({ c: count() })
						.from(myUserAuditLogsTable)
						.where(eq(myUserAuditLogsTable.userId, userId))
				)[0]?.c ?? 0
			);
			const rows = await drizzle
				.select()
				.from(myUserAuditLogsTable)
				.where(eq(myUserAuditLogsTable.userId, userId))
				.orderBy(desc(myUserAuditLogsTable.createdAt))
				.limit(pageSize)
				.offset(offset);
			return { logs: rows.map((r) => mapMyAuditRow(r as MyAuditSelectRow)), total };
		},

		async getGlobalUserAuditLogs(options: {
			page?: number;
			pageSize?: number;
			userId?: string;
			apiKeyId?: string;
			userEmail?: string;
			eventTypes?: string[];
			actorTypes?: string[];
			actorId?: string;
			actorKinds?: string[];
			reasonCodes?: string[];
			sources?: string[];
			correlationId?: string;
			startDate?: string;
			endDate?: string;
			endDateExclusive?: boolean;
		}): Promise<{ logs: GlobalUserAuditLogRow[]; total: number }> {
			const page = options.page || 1;
			const pageSize = Math.min(options.pageSize || 20, 100);
			const offset = (page - 1) * pageSize;
			const whereExpr = globalAuditWhere(options);

			let countQ = drizzle
				.select({ total: count() })
				.from(myUserAuditLogsTable)
				.leftJoin(myUsersTable, eq(myUserAuditLogsTable.userId, myUsersTable.id));
			if (whereExpr) countQ = countQ.where(whereExpr) as typeof countQ;
			const total = Number((await countQ)[0]?.total ?? 0);

			let listQ = drizzle
				.select(globalAuditSelectColumns)
				.from(myUserAuditLogsTable)
				.leftJoin(myUsersTable, eq(myUserAuditLogsTable.userId, myUsersTable.id));
			if (whereExpr) listQ = listQ.where(whereExpr) as typeof listQ;
			const rows = await listQ
				.orderBy(desc(myUserAuditLogsTable.createdAt), desc(myUserAuditLogsTable.id))
				.limit(pageSize)
				.offset(offset);

			return {
				logs: rows.map((r) => {
					const { user_email, ...rest } = r;
					return { ...mapMyAuditRow(rest as MyAuditSelectRow), user_email };
				}),
				total,
			};
		},

		async scanGlobalUserAuditLogsForExport({ filters, limit, after, highWater }) {
			if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Invalid audit export batch size');
			const conditions: SQL[] = [];
			const filtered = globalAuditWhere(filters);
			if (filtered) conditions.push(filtered);
			if (highWater) {
				const time = myUserAuditLogsTable.createdAt;
				const cursorTime = mysqlAuditUtcCursor(highWater.createdAt);
				conditions.push(or(
					lt(time, cursorTime),
					and(eq(time, cursorTime), lte(myUserAuditLogsTable.id, highWater.id)),
				)!);
			}
			if (after) {
				const time = myUserAuditLogsTable.createdAt;
				const cursorTime = mysqlAuditUtcCursor(after.createdAt);
				conditions.push(or(
					lt(time, cursorTime),
					and(eq(time, cursorTime), lt(myUserAuditLogsTable.id, after.id)),
				)!);
			}
			const whereExpr = conditions.length ? and(...conditions) : undefined;
			let query = drizzle.select(exportSelectColumns).from(myUserAuditLogsTable)
				.leftJoin(myUsersTable, eq(myUserAuditLogsTable.userId, myUsersTable.id));
			if (whereExpr) query = query.where(whereExpr) as typeof query;
			const exportQuery = query.orderBy(desc(myUserAuditLogsTable.createdAt), desc(myUserAuditLogsTable.id)).limit(limit);
			const compiled = exportQuery.toSQL();
			if (!/^select\s/u.test(compiled.sql)) throw new Error('Invalid audit export SELECT');
			// MySQL 8.4 applies this read-only SELECT hint on the server. A client-side
			// Promise timeout would leave the database query running.
			const timedSql = compiled.sql.replace(/^select\s/u,
				`select /*+ MAX_EXECUTION_TIME(${USER_AUDIT_EXPORT_QUERY_TIMEOUT_MS}) */ `);
			const [result] = await db.raw.execute(timedSql, compiled.params as Array<string | number | null>);
			if (!Array.isArray(result)) throw new Error('Invalid audit export result');
			type ExportRow = Awaited<ReturnType<typeof exportQuery.execute>>[number];
			const rows = result as unknown as ExportRow[];
			return rows.map((row) => {
				const { cursorCreatedAt } = row;
				const createdAtUtc = mysqlAuditUtcCursor(cursorCreatedAt);
				return {
					log: {
						id: row.id ?? '', created_at: createdAtUtc, request_log_id: row.requestLogId,
						correlation_id: row.correlationId, event_type: row.eventType ?? '',
						source: row.source, reason_code: row.reasonCode, reason_text: row.reasonText,
						actor_type: row.actorType ?? '', actor_id: row.actorId, user_id: row.userId,
						user_email: row.userEmail, api_key_id: row.apiKeyId,
						before_user_snapshot: row.beforeUserSnapshot,
						after_user_snapshot: row.afterUserSnapshot,
					},
					cursor: { createdAt: createdAtUtc, id: row.id ?? '' },
					oversized: Number(row.oversized) === 1,
				};
			});
		},

		async getGlobalUserAuditLogFilterOptions(): Promise<{ reasonCodes: string[] }> {
			const rows = await drizzle
				.select({ reasonCode: myUserAuditLogsTable.reasonCode })
				.from(myUserAuditLogsTable)
				.where(sql`${myUserAuditLogsTable.reasonCode} IS NOT NULL AND ${myUserAuditLogsTable.reasonCode} <> ''`)
				.groupBy(myUserAuditLogsTable.reasonCode)
				.orderBy(myUserAuditLogsTable.reasonCode);
			return { reasonCodes: rows.map((row) => row.reasonCode).filter((value): value is string => !!value) };
		},
	};
}
