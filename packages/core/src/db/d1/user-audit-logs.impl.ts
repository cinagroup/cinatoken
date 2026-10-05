/**
 * D1：`user_audit_logs`。
 */
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { GlobalUserAuditLogRow, UserAuditLogRow } from '../../types';
import type { D1DatabaseClient } from '../../storage/database-client';
import type {
	GlobalUserAuditLogFilters,
	UserAuditLogCursor,
	UserAuditLogsRepository,
} from '../../storage/gateway-repository-interfaces';
import type { InsertUserAuditLogParams } from '../user-audit-logs-types';
import {
	assertAndFinalizeUserAuditInsert,
	normalizeUserAuditActorKinds,
	userAuditActorKindPrefixRange,
} from '../user-audit-catalog';
import { deriveUserAuditBudgetFromSnapshots } from '../user-audit-log-derived';
import { USER_AUDIT_EXPORT_TEXT_LIMITS as exportLimits } from '../user-audit-export-limits';

type AuditSqlRow = {
	id: string;
	user_id: string | null;
	api_key_id: string | null;
	event_type: string;
	actor_type: string;
	request_log_id: string | null;
	change_payload: string | null;
	before_user_snapshot: string | null;
	after_user_snapshot: string | null;
	changed_fields: string | null;
	correlation_id: string | null;
	source: string | null;
	actor_id: string | null;
	reason_code: string | null;
	reason_text: string | null;
	created_at: string;
};

function mapAuditRow(r: AuditSqlRow): UserAuditLogRow {
	const derived = deriveUserAuditBudgetFromSnapshots(r.before_user_snapshot, r.after_user_snapshot);
	return {
		id: r.id,
		user_id: r.user_id,
		api_key_id: r.api_key_id,
		event_type: r.event_type,
		actor_type: r.actor_type,
		before_spent: derived.before_spent,
		delta_spent: derived.delta_spent,
		after_spent: derived.after_spent,
		before_budget_max: derived.before_budget_max,
		after_budget_max: derived.after_budget_max,
		before_budget_base: derived.before_budget_base,
		after_budget_base: derived.after_budget_base,
		request_log_id: r.request_log_id,
		change_payload: r.change_payload,
		before_user_snapshot: r.before_user_snapshot ?? null,
		after_user_snapshot: r.after_user_snapshot ?? null,
		changed_fields: r.changed_fields ?? null,
		correlation_id: r.correlation_id ?? null,
		source: r.source ?? null,
		actor_id: r.actor_id ?? null,
		reason_code: r.reason_code ?? null,
		reason_text: r.reason_text ?? null,
		created_at: r.created_at,
	};
}

export function buildInsertUserAuditLogStatement(db: D1Database, params: InsertUserAuditLogParams): D1PreparedStatement {
	const p = assertAndFinalizeUserAuditInsert(params);
	return db
		.prepare(
			`INSERT INTO user_audit_logs (
        id, user_id, api_key_id, event_type, actor_type,
        request_log_id, change_payload,
        before_user_snapshot, after_user_snapshot, changed_fields,
        correlation_id, source, actor_id, reason_code, reason_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			p.id,
			p.userId,
			p.apiKeyId ?? null,
			p.eventType,
			p.actorType,
			p.requestLogId ?? null,
			p.changePayload ?? null,
			p.beforeUserSnapshot ?? null,
			p.afterUserSnapshot ?? null,
			p.changedFields ?? null,
			p.correlationId ?? null,
			p.source ?? null,
			p.actorId ?? null,
			p.reasonCode ?? null,
			p.reasonText ?? null
		);
}

const auditRowColumnsNoAlias = `id,
      user_id,
      api_key_id,
      event_type,
      actor_type,
      request_log_id,
      change_payload,
      before_user_snapshot,
      after_user_snapshot,
      changed_fields,
      correlation_id,
      source,
      actor_id,
      reason_code,
      reason_text,
      created_at`;

const auditRowColumnsAliased = `a.id,
      a.user_id,
      a.api_key_id,
      a.event_type,
      a.actor_type,
      a.request_log_id,
      a.change_payload,
      a.before_user_snapshot,
      a.after_user_snapshot,
      a.changed_fields,
      a.correlation_id,
      a.source,
      a.actor_id,
      a.reason_code,
      a.reason_text,
      a.created_at`;

// SQLite audit timestamps exist as both SQL UTC seconds and ISO UTC strings.
// Use one comparable UTC expression for filters, ordering, and export cursors.
const auditUtcTime = `strftime('%Y-%m-%dT%H:%M:%fZ', a.created_at)`;

const exportTextColumns = [
	['a.id', 'id', exportLimits.id],
	['a.created_at', 'created_at', exportLimits.createdAt],
	['a.request_log_id', 'request_log_id', exportLimits.requestLogId],
	['a.correlation_id', 'correlation_id', exportLimits.correlationId],
	['a.event_type', 'event_type', exportLimits.eventType],
	['a.source', 'source', exportLimits.source],
	['a.reason_code', 'reason_code', exportLimits.reasonCode],
	['a.reason_text', 'reason_text', exportLimits.reasonText],
	['a.actor_type', 'actor_type', exportLimits.actorType],
	['a.actor_id', 'actor_id', exportLimits.actorId],
	['a.user_id', 'user_id', exportLimits.userId],
	['u.email', 'user_email', exportLimits.userEmail],
	['a.api_key_id', 'api_key_id', exportLimits.apiKeyId],
	['a.before_user_snapshot', 'before_user_snapshot', exportLimits.userSnapshot],
	['a.after_user_snapshot', 'after_user_snapshot', exportLimits.userSnapshot],
] as const;
const exportProjection = exportTextColumns.map(([column, alias, max]) =>
	`CASE WHEN length(CAST(${column} AS BLOB)) > ${max} THEN NULL ELSE ${column} END AS ${alias}`
).join(',\n');
const exportOversized = `CASE WHEN ${exportTextColumns.map(([column, , max]) =>
	`length(CAST(${column} AS BLOB)) > ${max}`
).join(' OR ')} THEN 1 ELSE 0 END`;

type AuditExportSqlRow = Pick<AuditSqlRow,
	'id' | 'created_at' | 'request_log_id' | 'correlation_id' | 'event_type' |
	'source' | 'reason_code' | 'reason_text' | 'actor_type' | 'actor_id' |
	'user_id' | 'api_key_id' | 'before_user_snapshot' | 'after_user_snapshot'
> & { user_email: string | null; cursor_created_at: string | null; oversized: number };

function globalAuditWhere(options: GlobalUserAuditLogFilters): { conditions: string[]; values: unknown[] } {
	const conditions: string[] = [];
	const values: unknown[] = [];
	const equal = (column: string, value?: string) => {
		if (value) {
			conditions.push(`${column} = ?`);
			values.push(value);
		}
	};
	const inValues = (column: string, selected?: string[]) => {
		if (selected?.length) {
			conditions.push(`${column} IN (${selected.map(() => '?').join(', ')})`);
			values.push(...selected);
		}
	};
	equal('a.user_id', options.userId);
	equal('a.api_key_id', options.apiKeyId);
	equal('u.email', options.userEmail);
	inValues('a.event_type', options.eventTypes);
	inValues('a.actor_type', options.actorTypes);
	equal('a.actor_id', options.actorId);
	const actorKinds = normalizeUserAuditActorKinds(options.actorKinds ?? []);
	if (actorKinds.length) {
		const ranges = actorKinds.map((kind) => {
			const { lower, upper } = userAuditActorKindPrefixRange(kind);
			values.push(lower, upper);
			return '(a.actor_id >= ? AND a.actor_id < ?)';
		});
		conditions.push(`(${ranges.join(' OR ')})`);
	}
	inValues('a.reason_code', options.reasonCodes);
	inValues('a.source', options.sources);
	equal('a.correlation_id', options.correlationId);
	if (options.startDate) {
		conditions.push(`${auditUtcTime} >= strftime('%Y-%m-%dT%H:%M:%fZ', ?)`);
		values.push(options.startDate);
	}
	if (options.endDate) {
		conditions.push(`${auditUtcTime} ${options.endDateExclusive ? '<' : '<='} strftime('%Y-%m-%dT%H:%M:%fZ', ?)`);
		values.push(options.endDate);
	}
	return { conditions, values };
}

function addCursorBound(conditions: string[], values: unknown[], cursor: UserAuditLogCursor, operator: '<' | '<=') {
	conditions.push(`(${auditUtcTime} < ? OR (${auditUtcTime} = ? AND a.id ${operator} ?))`);
	values.push(cursor.createdAt, cursor.createdAt, cursor.id);
}

export function createD1UserAuditLogsRepository(db: D1DatabaseClient): UserAuditLogsRepository {
	const raw = db.raw;
	return {
		async insertUserAuditLog(params: InsertUserAuditLogParams): Promise<void> {
			await buildInsertUserAuditLogStatement(raw, params).run();
		},

		async getUserAuditLogsByUserId(
			userId: string,
			page: number,
			pageSize: number
		): Promise<{ logs: UserAuditLogRow[]; total: number }> {
			const offset = (page - 1) * pageSize;
			const countRow = await raw
				.prepare('SELECT COUNT(*) AS total FROM user_audit_logs WHERE user_id = ?')
				.bind(userId)
				.first<{ total: number }>();
			const logsRes = await raw
				.prepare(
					`SELECT ${auditRowColumnsNoAlias} FROM user_audit_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`
				)
				.bind(userId, pageSize, offset)
				.all<AuditSqlRow>();
			return {
				logs: (logsRes.results ?? []).map(mapAuditRow),
				total: Number(countRow?.total ?? 0),
			};
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
			const { conditions, values: bindValues } = globalAuditWhere(options);
			const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
			const baseFrom = `FROM user_audit_logs a LEFT JOIN users u ON u.id = a.user_id`;
			const countRow = await raw
				.prepare(`SELECT COUNT(*) AS total ${baseFrom} ${whereClause}`)
				.bind(...bindValues)
				.first<{ total: number }>();
			const total = Number(countRow?.total ?? 0);
			const selectSql = `SELECT
      ${auditRowColumnsAliased},
      u.email AS user_email
    ${baseFrom}
    ${whereClause}
			ORDER BY ${auditUtcTime} DESC, a.id DESC
    LIMIT ? OFFSET ?`;
			const rows = await raw.prepare(selectSql).bind(...bindValues, pageSize, offset).all<AuditSqlRow & { user_email: string | null }>();
			return {
				logs: (rows.results ?? []).map((r) => ({ ...mapAuditRow(r), user_email: r.user_email })),
				total,
			};
		},

		async scanGlobalUserAuditLogsForExport({ filters, limit, after, highWater }) {
			if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Invalid audit export batch size');
			const { conditions, values } = globalAuditWhere(filters);
			if (highWater) addCursorBound(conditions, values, highWater, '<=');
			if (after) addCursorBound(conditions, values, after, '<');
			const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
			const rows = await raw.prepare(`SELECT ${exportProjection},
				${auditUtcTime} AS cursor_created_at, ${exportOversized} AS oversized
				FROM user_audit_logs a LEFT JOIN users u ON u.id = a.user_id
				${whereClause}
				ORDER BY ${auditUtcTime} DESC, a.id DESC LIMIT ?`)
				.bind(...values, limit)
				.all<AuditExportSqlRow>();
			return (rows.results ?? []).map((row) => {
				if (!row.cursor_created_at && row.oversized !== 1) throw new Error('Invalid audit timestamp in export scan');
				return {
					log: {
						id: row.id ?? '', created_at: row.created_at ?? '', request_log_id: row.request_log_id,
						correlation_id: row.correlation_id, event_type: row.event_type ?? '',
						source: row.source, reason_code: row.reason_code, reason_text: row.reason_text,
						actor_type: row.actor_type ?? '', actor_id: row.actor_id, user_id: row.user_id,
						user_email: row.user_email, api_key_id: row.api_key_id,
						before_user_snapshot: row.before_user_snapshot,
						after_user_snapshot: row.after_user_snapshot,
					},
					cursor: { createdAt: row.cursor_created_at ?? '', id: row.id ?? '' },
					oversized: row.oversized === 1,
				};
			});
		},

		async getGlobalUserAuditLogFilterOptions(): Promise<{ reasonCodes: string[] }> {
			const rows = await raw
				.prepare(
					`SELECT DISTINCT reason_code FROM user_audit_logs WHERE reason_code IS NOT NULL AND reason_code <> '' ORDER BY reason_code`
				)
				.all<{ reason_code: string }>();
			return {
				reasonCodes: (rows.results ?? []).map((row) => row.reason_code).filter((value) => value !== ''),
			};
		},
	};
}
