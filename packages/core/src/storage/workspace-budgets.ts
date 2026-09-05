import type { RowDataPacket } from 'mysql2/promise';
import type { GatewayDatabaseClient } from './database-client';
import { mysqlExecute, mysqlQueryRows, toMySqlDateTime } from '../db/mysql/mysql2-compat';
import {
	assertManagementApiKeyAccount,
	type ManagementApiKeyAccount,
} from '../db/management-api-keys-types';
import {
	buildWorkspaceBudgetIntent,
	normalizeWorkspaceBudgetInterval,
	validateWorkspaceBudgetOrdering,
	WORKSPACE_BUDGET_MAX_EPOCH,
	type WorkspaceBudgetInterval,
	type WorkspaceBudgetRow,
	type WorkspaceBudgetUsageRow,
} from '../workspace-budgets';

type RawWorkspaceBudgetRow = {
	id: string;
	workspace_id: string;
	reset_interval: string;
	limit_micros: number | string;
	config_epoch: number | string;
	workspace_created_at: string | Date;
	created_at: string | Date;
	updated_at: string | Date;
};

type MySqlWorkspaceBudgetRow = RawWorkspaceBudgetRow & RowDataPacket;

type RawWorkspaceBudgetWindow = {
	unreserved_micros: number | string;
	settled_micros: number | string;
	reserved_micros: number | string;
};

type RawWorkspaceBudgetLogUsage = {
	spent_micros: number | string;
};

function isoTimestamp(value: string | Date): string {
	if (value instanceof Date) return value.toISOString();
	const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/u.test(value)
		? `${value.replace(' ', 'T')}Z`
		: value;
	const milliseconds = Date.parse(normalized);
	if (!Number.isFinite(milliseconds)) throw new TypeError('Workspace budget timestamp is invalid');
	return new Date(milliseconds).toISOString();
}

function mapRow(row: RawWorkspaceBudgetRow): WorkspaceBudgetRow {
	const limitMicros = Number(row.limit_micros);
	const configEpoch = Number(row.config_epoch);
	if (!Number.isSafeInteger(limitMicros) || limitMicros <= 0) throw new TypeError('Workspace budget limit is invalid');
	if (!Number.isSafeInteger(configEpoch) || configEpoch < 0 || configEpoch > WORKSPACE_BUDGET_MAX_EPOCH) {
		throw new TypeError('Workspace budget epoch is invalid');
	}
	return {
		id: row.id,
		workspace_id: row.workspace_id,
		reset_interval: normalizeWorkspaceBudgetInterval(row.reset_interval),
		limit_micros: limitMicros,
		config_epoch: configEpoch,
		workspace_created_at: isoTimestamp(row.workspace_created_at),
		created_at: isoTimestamp(row.created_at),
		updated_at: isoTimestamp(row.updated_at),
	};
}

const D1_SELECT = `SELECT budget.id, budget.workspace_id, budget.reset_interval,
	budget.limit_micros, budget.config_epoch, workspace.created_at AS workspace_created_at,
	budget.created_at, budget.updated_at
	FROM workspace_budgets budget
	JOIN workspaces workspace ON workspace.id = budget.workspace_id
	WHERE budget.workspace_id = ? AND workspace.status = 'active'
	ORDER BY CASE budget.reset_interval
		WHEN 'daily' THEN 1 WHEN 'weekly' THEN 2 WHEN 'monthly' THEN 3 ELSE 4 END`;

const POSTGRES_SELECT = `SELECT budget.id, budget.workspace_id, budget.reset_interval,
	budget.limit_micros, budget.config_epoch, workspace.created_at AS workspace_created_at,
	budget.created_at, budget.updated_at
	FROM workspace_budgets budget
	JOIN workspaces workspace ON workspace.id = budget.workspace_id
	WHERE budget.workspace_id = $1 AND workspace.status = 'active'
	ORDER BY CASE budget.reset_interval
		WHEN 'daily' THEN 1 WHEN 'weekly' THEN 2 WHEN 'monthly' THEN 3 ELSE 4 END`;

const MYSQL_SELECT = `SELECT budget.id, budget.workspace_id, budget.reset_interval,
	budget.limit_micros, budget.config_epoch, workspace.created_at AS workspace_created_at,
	budget.created_at, budget.updated_at
	FROM workspace_budgets budget
	JOIN workspaces workspace ON workspace.id = budget.workspace_id
	WHERE budget.workspace_id = ? AND workspace.status = 'active'
	ORDER BY CASE budget.reset_interval
		WHEN 'daily' THEN 1 WHEN 'weekly' THEN 2 WHEN 'monthly' THEN 3 ELSE 4 END`;

export async function listWorkspaceBudgets(
	client: GatewayDatabaseClient,
	workspaceId: string,
): Promise<WorkspaceBudgetRow[]> {
	if (!workspaceId || workspaceId.length > 600) throw new TypeError('workspace id is invalid');
	if (client.driver === 'd1') {
		const rows = await client.raw.prepare(D1_SELECT).bind(workspaceId).all<RawWorkspaceBudgetRow>();
		return (rows.results ?? []).map(mapRow);
	}
	if (client.driver === 'postgres') {
		return (await client.raw.unsafe<RawWorkspaceBudgetRow[]>(POSTGRES_SELECT, [workspaceId])).map(mapRow);
	}
	return (await mysqlQueryRows<MySqlWorkspaceBudgetRow>(client.raw, MYSQL_SELECT, [workspaceId])).map(mapRow);
}

function safeUsageMicros(value: number | string, label: string): number {
	const micros = Number(value);
	if (!Number.isSafeInteger(micros) || micros < 0) {
		throw new TypeError(`Workspace budget ${label} is invalid`);
	}
	return micros;
}

async function readWorkspaceBudgetWindow(
	client: GatewayDatabaseClient,
	params: {
		workspaceId: string;
		period: WorkspaceBudgetInterval;
		periodStart: string;
		periodEnd: string;
	},
): Promise<RawWorkspaceBudgetWindow | null> {
	if (client.driver === 'd1') {
		return await client.raw.prepare(`SELECT unreserved_micros, settled_micros, reserved_micros
			FROM guardrail_budget_windows
			WHERE workspace_id = ? AND scope_type = 'workspace' AND scope_id = ?
				AND period = ? AND period_start = ? AND period_end = ?
			LIMIT 1`)
			.bind(params.workspaceId, params.workspaceId, params.period, params.periodStart, params.periodEnd)
			.first<RawWorkspaceBudgetWindow>();
	}
	if (client.driver === 'postgres') {
		const rows = await client.raw.unsafe<RawWorkspaceBudgetWindow[]>(`SELECT
			unreserved_micros, settled_micros, reserved_micros
			FROM guardrail_budget_windows
			WHERE workspace_id = $1 AND scope_type = 'workspace' AND scope_id = $1
				AND period = $2 AND period_start = $3::timestamptz AND period_end = $4::timestamptz
			LIMIT 1`, [params.workspaceId, params.period, params.periodStart, params.periodEnd]);
		return rows[0] ?? null;
	}
	const rows = await mysqlQueryRows<RowDataPacket & RawWorkspaceBudgetWindow>(client.raw, `SELECT
		unreserved_micros, settled_micros, reserved_micros
		FROM guardrail_budget_windows
		WHERE workspace_id = ? AND scope_type = 'workspace' AND scope_id = ?
			AND period = ? AND period_start = ? AND period_end = ?
		LIMIT 1`, [
		params.workspaceId,
		params.workspaceId,
		params.period,
		toMySqlDateTime(params.periodStart),
		toMySqlDateTime(params.periodEnd),
	]);
	return rows[0] ?? null;
}

async function readWorkspaceBudgetLogUsage(
	client: GatewayDatabaseClient,
	params: { workspaceId: string; periodStart: string; periodEnd: string },
): Promise<number> {
	let row: RawWorkspaceBudgetLogUsage | null;
	if (client.driver === 'd1') {
		row = await client.raw.prepare(`SELECT COALESCE(SUM(COALESCE(
				budget_charged_micros,
				CAST(ROUND(MAX(charged_cost, 0) * 1000000) AS INTEGER)
			)), 0) AS spent_micros
			FROM api_key_request_logs
			WHERE workspace_id = ?
				AND COALESCE(budget_accounted_at, created_at) >= ?
				AND COALESCE(budget_accounted_at, created_at) < ?`)
			.bind(params.workspaceId, params.periodStart, params.periodEnd)
			.first<RawWorkspaceBudgetLogUsage>();
	} else if (client.driver === 'postgres') {
		const rows = await client.raw.unsafe<RawWorkspaceBudgetLogUsage[]>(`SELECT COALESCE(SUM(COALESCE(
				budget_charged_micros,
				ROUND(GREATEST(charged_cost, 0) * 1000000)::bigint
			)), 0) AS spent_micros
			FROM api_key_request_logs
			WHERE workspace_id = $1
				AND COALESCE(budget_accounted_at, created_at) >= $2::timestamptz
				AND COALESCE(budget_accounted_at, created_at) < $3::timestamptz`, [
			params.workspaceId,
			params.periodStart,
			params.periodEnd,
		]);
		row = rows[0] ?? null;
	} else {
		const rows = await mysqlQueryRows<RowDataPacket & RawWorkspaceBudgetLogUsage>(client.raw, `SELECT
			COALESCE(SUM(COALESCE(
				budget_charged_micros,
				CAST(ROUND(GREATEST(charged_cost, 0) * 1000000) AS UNSIGNED)
			)), 0) AS spent_micros
			FROM api_key_request_logs
			WHERE workspace_id = ?
				AND budget_accounted_effective_at >= ?
				AND budget_accounted_effective_at < ?`, [
			params.workspaceId,
			toMySqlDateTime(params.periodStart),
			toMySqlDateTime(params.periodEnd),
		]);
		row = rows[0] ?? null;
	}
	return safeUsageMicros(row?.spent_micros ?? 0, 'spent amount');
}

function mapUsage(
	budget: WorkspaceBudgetRow,
	periodStart: string,
	periodEnd: string,
	window: RawWorkspaceBudgetWindow | null,
	fallbackSpentMicros: number,
): WorkspaceBudgetUsageRow {
	const unreservedMicros = window ? safeUsageMicros(window.unreserved_micros, 'unreserved amount') : fallbackSpentMicros;
	const settledMicros = window ? safeUsageMicros(window.settled_micros, 'settled amount') : 0;
	const reservedMicros = window ? safeUsageMicros(window.reserved_micros, 'reserved amount') : 0;
	const spentMicros = unreservedMicros + settledMicros;
	const consumedMicros = spentMicros + reservedMicros;
	if (!Number.isSafeInteger(spentMicros) || !Number.isSafeInteger(consumedMicros)) {
		throw new TypeError('Workspace budget usage total is invalid');
	}
	return {
		...budget,
		period_start: periodStart,
		period_end: periodEnd,
		spent_micros: spentMicros,
		reserved_micros: reservedMicros,
		remaining_micros: Math.max(0, budget.limit_micros - consumedMicros),
	};
}

/**
 * Read current Workspace budget snapshots for the user portal. The request
 * admission path continues to use the lighter listWorkspaceBudgets query.
 */
export async function listWorkspaceBudgetUsage(
	client: GatewayDatabaseClient,
	workspaceId: string,
	now = new Date(),
): Promise<WorkspaceBudgetUsageRow[]> {
	if (!Number.isFinite(now.getTime())) throw new TypeError('Workspace budget snapshot time is invalid');
	const budgets = await listWorkspaceBudgets(client, workspaceId);
	const result: WorkspaceBudgetUsageRow[] = [];
	for (const budget of budgets) {
		const intent = buildWorkspaceBudgetIntent(budget, now);
		const windowParams = {
			workspaceId,
			period: budget.reset_interval,
			periodStart: intent.periodStart,
			periodEnd: intent.periodEnd,
		};
		let window = await readWorkspaceBudgetWindow(client, windowParams);
		let fallbackSpentMicros = 0;
		if (!window) {
			fallbackSpentMicros = await readWorkspaceBudgetLogUsage(client, windowParams);
			// A request may have materialized the authoritative window while the
			// legacy-log snapshot was being read. Prefer that ledger if it now exists.
			window = await readWorkspaceBudgetWindow(client, windowParams);
		}
		result.push(mapUsage(budget, intent.periodStart, intent.periodEnd, window, fallbackSpentMicros));
	}
	return result;
}

/** Resolve OpenRouter's Workspace `id_or_slug` within one Management-key account. */
export async function resolveWorkspaceSlugForManagementAccount(
	client: GatewayDatabaseClient,
	slug: string,
	account: ManagementApiKeyAccount,
): Promise<string | null> {
	const normalized = slug.trim();
	if (!normalized || normalized.length > 255) return null;
	assertManagementApiKeyAccount(account);

	if (client.driver === 'd1') {
		const personal = account.accountType === 'personal';
		const row = await client.raw.prepare(`SELECT id FROM workspaces
			WHERE slug = ? AND status = 'active' AND scope_type = ?
				AND ${personal
					? 'personal_owner_user_id = ? AND organization_id IS NULL'
					: 'personal_owner_user_id IS NULL AND organization_id = ?'}
			LIMIT 1`)
			.bind(normalized, account.accountType, personal ? account.personalOwnerUserId : account.organizationId)
			.first<{ id: string }>();
		return row?.id ?? null;
	}

	if (client.driver === 'postgres') {
		const personal = account.accountType === 'personal';
		const rows = await client.raw.unsafe<Array<{ id: string }>>(`SELECT id FROM workspaces
			WHERE slug = $1 AND status = 'active' AND scope_type = $2
				AND ${personal
					? 'personal_owner_user_id = $3 AND organization_id IS NULL'
					: 'personal_owner_user_id IS NULL AND organization_id = $3'}
			LIMIT 1`, [normalized, account.accountType, personal ? account.personalOwnerUserId : account.organizationId]);
		return rows[0]?.id ?? null;
	}

	const personal = account.accountType === 'personal';
	const rows = await mysqlQueryRows<RowDataPacket & { id: string }>(client.raw, `SELECT id FROM workspaces
		WHERE slug = ? AND status = 'active' AND scope_type = ?
			AND ${personal
				? 'personal_owner_user_id = ? AND organization_id IS NULL'
				: 'personal_owner_user_id IS NULL AND organization_id = ?'}
		LIMIT 1`, [normalized, account.accountType, personal ? account.personalOwnerUserId : account.organizationId]);
	return rows[0]?.id ?? null;
}

function assertProposedOrdering(
	existing: WorkspaceBudgetRow[],
	interval: WorkspaceBudgetInterval,
	limitMicros: number,
): void {
	const proposed = [
		...existing.filter((budget) => budget.reset_interval !== interval),
		{ reset_interval: interval, limit_micros: limitMicros },
	];
	const invalid = validateWorkspaceBudgetOrdering(proposed);
	if (invalid) throw new TypeError(invalid);
	const current = existing.find((budget) => budget.reset_interval === interval);
	if (current && current.config_epoch >= WORKSPACE_BUDGET_MAX_EPOCH) {
		throw new TypeError('Workspace budget epoch is exhausted');
	}
}

function d1Error(error: unknown): never {
	const message = error instanceof Error ? error.message : String(error);
	if (message.includes('workspace_budget_order_invalid')) {
		throw new TypeError('Workspace budget limits must satisfy lifetime > monthly > weekly > daily');
	}
	throw error;
}

export async function upsertWorkspaceBudget(
	client: GatewayDatabaseClient,
	params: {
		workspaceId: string;
		interval: WorkspaceBudgetInterval;
		limitMicros: number;
		nowIso?: string;
	},
): Promise<WorkspaceBudgetRow | null> {
	const interval = normalizeWorkspaceBudgetInterval(params.interval);
	if (!params.workspaceId || params.workspaceId.length > 600) throw new TypeError('workspace id is invalid');
	if (!Number.isSafeInteger(params.limitMicros) || params.limitMicros <= 0) throw new TypeError('Workspace budget limit is invalid');
	const nowIso = isoTimestamp(params.nowIso ?? new Date().toISOString());
	const id = crypto.randomUUID();

	if (client.driver === 'd1') {
		const existing = await listWorkspaceBudgets(client, params.workspaceId);
		const workspace = await client.raw.prepare(`SELECT id FROM workspaces WHERE id = ? AND status = 'active'`)
			.bind(params.workspaceId).first<{ id: string }>();
		if (!workspace) return null;
		assertProposedOrdering(existing, interval, params.limitMicros);
		try {
			await client.raw.prepare(`INSERT INTO workspace_budgets (
				id, workspace_id, reset_interval, limit_micros, config_epoch, created_at, updated_at
			) VALUES (?, ?, ?, ?, 0, ?, ?)
			ON CONFLICT(workspace_id, reset_interval) DO UPDATE SET
				limit_micros = excluded.limit_micros,
				config_epoch = workspace_budgets.config_epoch + 1,
				updated_at = excluded.updated_at`)
				.bind(id, params.workspaceId, interval, params.limitMicros, nowIso, nowIso).run();
		} catch (error) {
			d1Error(error);
		}
		return (await listWorkspaceBudgets(client, params.workspaceId))
			.find((budget) => budget.reset_interval === interval) ?? null;
	}

	if (client.driver === 'postgres') {
		return await client.raw.begin(async (transaction) => {
			const workspaceRows = await transaction.unsafe<Array<{ id: string }>>(
				`SELECT id FROM workspaces WHERE id = $1 AND status = 'active' FOR UPDATE`,
				[params.workspaceId],
			);
			if (workspaceRows.length === 0) return null;
			const rows = await transaction.unsafe<RawWorkspaceBudgetRow[]>(
				`${POSTGRES_SELECT} FOR UPDATE OF budget`,
				[params.workspaceId],
			);
			assertProposedOrdering(rows.map(mapRow), interval, params.limitMicros);
			await transaction.unsafe(`INSERT INTO workspace_budgets (
				id, workspace_id, reset_interval, limit_micros, config_epoch, created_at, updated_at
			) VALUES ($1, $2, $3, $4, 0, $5, $5)
			ON CONFLICT (workspace_id, reset_interval) DO UPDATE SET
				limit_micros = EXCLUDED.limit_micros,
				config_epoch = workspace_budgets.config_epoch + 1,
				updated_at = EXCLUDED.updated_at`, [id, params.workspaceId, interval, params.limitMicros, nowIso]);
			const updated = await transaction.unsafe<RawWorkspaceBudgetRow[]>(
				`${POSTGRES_SELECT.replace('ORDER BY CASE budget.reset_interval', 'AND budget.reset_interval = $2 ORDER BY CASE budget.reset_interval')}`,
				[params.workspaceId, interval],
			);
			return updated[0] ? mapRow(updated[0]) : null;
		});
	}

	const connection = await client.raw.getConnection();
	try {
		await connection.beginTransaction();
		const [workspaceRows] = await connection.query<Array<RowDataPacket & { id: string }>>(
			`SELECT id FROM workspaces WHERE id = ? AND status = 'active' FOR UPDATE`,
			[params.workspaceId],
		);
		if (workspaceRows.length === 0) {
			await connection.rollback();
			return null;
		}
		const [rows] = await connection.query<MySqlWorkspaceBudgetRow[]>(`${MYSQL_SELECT} FOR UPDATE`, [params.workspaceId]);
		assertProposedOrdering(rows.map(mapRow), interval, params.limitMicros);
		const mysqlNow = toMySqlDateTime(nowIso);
		await mysqlExecute(connection, `INSERT INTO workspace_budgets (
			id, workspace_id, reset_interval, limit_micros, config_epoch, created_at, updated_at
		) VALUES (?, ?, ?, ?, 0, ?, ?)
		ON DUPLICATE KEY UPDATE
			limit_micros = VALUES(limit_micros),
			config_epoch = config_epoch + 1,
			updated_at = VALUES(updated_at)`, [id, params.workspaceId, interval, params.limitMicros, mysqlNow, mysqlNow]);
		await connection.commit();
	} catch (error) {
		await connection.rollback().catch(() => undefined);
		throw error;
	} finally {
		connection.release();
	}
	return (await listWorkspaceBudgets(client, params.workspaceId))
		.find((budget) => budget.reset_interval === interval) ?? null;
}

export async function deleteWorkspaceBudget(
	client: GatewayDatabaseClient,
	workspaceId: string,
	intervalValue: WorkspaceBudgetInterval,
): Promise<boolean> {
	const interval = normalizeWorkspaceBudgetInterval(intervalValue);
	if (!workspaceId || workspaceId.length > 600) throw new TypeError('workspace id is invalid');
	if (client.driver === 'd1') {
		const workspace = await client.raw.prepare(`SELECT id FROM workspaces WHERE id = ? AND status = 'active'`)
			.bind(workspaceId).first<{ id: string }>();
		if (!workspace) return false;
		await client.raw.prepare(`DELETE FROM workspace_budgets WHERE workspace_id = ? AND reset_interval = ?`)
			.bind(workspaceId, interval).run();
		return true;
	}
	if (client.driver === 'postgres') {
		return await client.raw.begin(async (transaction) => {
			const workspace = await transaction.unsafe<Array<{ id: string }>>(
				`SELECT id FROM workspaces WHERE id = $1 AND status = 'active' FOR UPDATE`,
				[workspaceId],
			);
			if (workspace.length === 0) return false;
			await transaction.unsafe(`DELETE FROM workspace_budgets WHERE workspace_id = $1 AND reset_interval = $2`, [workspaceId, interval]);
			return true;
		});
	}
	const connection = await client.raw.getConnection();
	try {
		await connection.beginTransaction();
		const [workspace] = await connection.query<Array<RowDataPacket & { id: string }>>(
			`SELECT id FROM workspaces WHERE id = ? AND status = 'active' FOR UPDATE`, [workspaceId]);
		if (workspace.length === 0) {
			await connection.rollback();
			return false;
		}
		await mysqlExecute(connection, `DELETE FROM workspace_budgets WHERE workspace_id = ? AND reset_interval = ?`, [workspaceId, interval]);
		await connection.commit();
		return true;
	} catch (error) {
		await connection.rollback().catch(() => undefined);
		throw error;
	} finally {
		connection.release();
	}
}
