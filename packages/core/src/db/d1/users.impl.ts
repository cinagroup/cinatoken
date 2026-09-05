/**
 * D1：`users` 表。
 */
import type { UserRow } from '../../types';
import { roundGatewayMoney } from '../../lib/money-precision';
import { userBudgetAmount, userBudgetUnits } from '../user-budget-reservation-types';
import type { D1DatabaseClient } from '../../storage/database-client';
import type { UsersRepository } from '../../storage/gateway-repository-interfaces';
import type { InsertUserParams, UserMaxBudgetFilter } from '../users-types';
import { defaultWorkspaceId } from '../../workspaces';
import {
	buildD1UserListOrderByClause,
	DEFAULT_USER_LIST_ORDER,
	DEFAULT_USER_LIST_SORT,
	type UserListSortField,
	type UserListSortOrder,
} from '../users-list-sort';

type UserSqlRow = {
	id: string;
	email: string | null;
	budget_max: number | null;
	budget_base: number;
	budget_spent: number;
	budget_period: string;
	budget_reset_at: string | null;
	budget_epoch: number;
	budget_reserved_micros: number;
	status: string;
	metadata: string | null;
	charged_cost_factors: string | null;
	external_system: string | null;
	external_user_id: string | null;
	created_at: string;
	updated_at: string;
};

function toD1BudgetSpentMicros(value: number): number {
	if (!Number.isFinite(value) || value < 0) {
		throw new Error('D1 ordinary-user budget spend must be a finite non-negative number');
	}
	return userBudgetUnits(value);
}

function mapUserRow(r: UserSqlRow): UserRow {
	return {
		id: r.id,
		email: r.email ?? '',
		budget_max: r.budget_max == null ? null : roundGatewayMoney(Number(r.budget_max)),
		budget_base: roundGatewayMoney(Number(r.budget_base ?? 0)),
		budget_spent: roundGatewayMoney(Number(r.budget_spent)),
		budget_period: r.budget_period,
		budget_reset_at: r.budget_reset_at,
		budget_epoch: Number(r.budget_epoch),
		budget_reserved_micros: Number(r.budget_reserved_micros),
		status: r.status,
		metadata: r.metadata,
		charged_cost_factors: r.charged_cost_factors ?? null,
		external_system: r.external_system,
		external_user_id: r.external_user_id,
		created_at: r.created_at,
		updated_at: r.updated_at,
	};
}

export function createD1UsersRepository(db: D1DatabaseClient): UsersRepository {
	const raw = db.raw;
	return {
		async getById(id: string): Promise<UserRow | null> {
			const row = await raw.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserSqlRow>();
			return row ? mapUserRow(row) : null;
		},

		async getByExternalPair(externalSystem: string, externalUserId: string): Promise<UserRow | null> {
			const row = await raw
				.prepare('SELECT * FROM users WHERE external_system = ? AND external_user_id = ?')
				.bind(externalSystem, externalUserId)
				.first<UserSqlRow>();
			return row ? mapUserRow(row) : null;
		},

		async listByEmail(email: string): Promise<UserRow[]> {
			const rows = await raw.prepare('SELECT * FROM users WHERE email = ? ORDER BY created_at DESC').bind(email).all<UserSqlRow>();
			return (rows.results ?? []).map(mapUserRow);
		},

		async list(options?: {
			email?: string;
			externalSystem?: string;
			externalUserId?: string;
			maxBudget?: UserMaxBudgetFilter;
			status?: string;
			page?: number;
			pageSize?: number;
			sort?: UserListSortField;
			order?: UserListSortOrder;
		}): Promise<{ users: UserRow[]; total: number }> {
			const page = options?.page || 1;
			const pageSize = Math.min(options?.pageSize || 20, 100);
			const offset = (page - 1) * pageSize;
			const conditions: string[] = [];
			const bindValues: unknown[] = [];
			if (options?.email) {
				conditions.push('email LIKE ?');
				bindValues.push(`%${options.email}%`);
			}
			if (options?.externalSystem) {
				conditions.push('external_system = ?');
				bindValues.push(options.externalSystem);
			}
			if (options?.externalUserId) {
				conditions.push('external_user_id = ?');
				bindValues.push(options.externalUserId);
			}
			if (options?.status) {
				conditions.push('status = ?');
				bindValues.push(options.status);
			}
			if (options?.maxBudget === 'positive') conditions.push('budget_max > 0');
			else if (options?.maxBudget === 'zero_or_negative') conditions.push('budget_max <= 0');
			else if (options?.maxBudget === 'null') conditions.push('budget_max IS NULL');
			const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
			const countRow = await raw
				.prepare(`SELECT COUNT(*) as total FROM users ${whereClause}`)
				.bind(...bindValues)
				.first<{ total: number }>();
			const total = Number(countRow?.total ?? 0);
			const sort = options?.sort ?? DEFAULT_USER_LIST_SORT;
			const order = options?.order ?? DEFAULT_USER_LIST_ORDER;
			const orderBy = buildD1UserListOrderByClause(sort, order);
			const rows = await raw
				.prepare(`SELECT * FROM users ${whereClause} ${orderBy} LIMIT ? OFFSET ?`)
				.bind(...bindValues, pageSize, offset)
				.all<UserSqlRow>();
			return { users: (rows.results ?? []).map(mapUserRow), total };
		},

		async createUser(params: InsertUserParams): Promise<void> {
			const budgetMax = params.budgetMax != null ? roundGatewayMoney(params.budgetMax) : null;
			const budgetBase = params.budgetBase != null ? roundGatewayMoney(params.budgetBase) : 0;
			const budgetSpentMicros = toD1BudgetSpentMicros(params.budgetSpent ?? 0);
			const budgetSpent = userBudgetAmount(budgetSpentMicros);
			const budgetPeriod = params.budgetPeriod ?? 'none';
			const budgetResetAt = params.budgetResetAt ?? null;
			const status = params.status ?? 'active';
			const workspaceId = defaultWorkspaceId('personal', params.id);
			const defaultGuardrailId = crypto.randomUUID();
			const defaultGuardrailVersionId = crypto.randomUUID();
			const accountDefaultGuardrailId = crypto.randomUUID();
			const accountDefaultGuardrailVersionId = crypto.randomUUID();
			await raw.batch([
				raw.prepare(
					`INSERT INTO users (id, email, budget_max, budget_base, budget_spent, budget_spent_micros, budget_period, budget_reset_at, status, metadata, charged_cost_factors, external_system, external_user_id, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
				)
				.bind(
					params.id,
					params.email,
					budgetMax,
					budgetBase,
					budgetSpent,
					budgetSpentMicros,
					budgetPeriod,
					budgetResetAt,
					status,
					params.metadata ?? null,
					params.chargedCostFactors ?? null,
					params.externalSystem ?? null,
					params.externalUserId ?? null
				),
				raw.prepare(`INSERT INTO workspaces (
					id, scope_type, personal_owner_user_id, name, slug, is_default,
					default_scope_key, status, created_by_user_id, created_at, updated_at
				) VALUES (?, 'personal', ?, 'Default', 'default', 1, ?, 'active', ?, datetime('now'), datetime('now'))`)
					.bind(workspaceId, params.id, workspaceId, params.id),
				raw.prepare(`INSERT INTO guardrails (
					id, workspace_id, owner_user_id, name, description, status,
					is_workspace_default, designated_version, latest_version, created_at, updated_at
				) VALUES (?, ?, ?, ?, NULL, 'active', 1, 1, 1, datetime('now'), datetime('now'))`)
					.bind(defaultGuardrailId, workspaceId, params.id,
						`Workspace ${workspaceId.slice(0, 180)} Default`),
				raw.prepare(`INSERT INTO guardrail_versions (
					id, guardrail_id, version, config_json, created_by_user_id, created_at
				) VALUES (?, ?, 1, '{}', ?, datetime('now'))`)
					.bind(defaultGuardrailVersionId, defaultGuardrailId, params.id),
				raw.prepare(`INSERT INTO guardrails (
					id, workspace_id, owner_user_id, name, description, status,
					is_workspace_default, is_account_default, account_scope_key,
					designated_version, latest_version, created_at, updated_at
				) VALUES (?, ?, ?, 'Account Default', NULL, 'active', 0, 1, ?, 1, 1, datetime('now'), datetime('now'))`)
					.bind(accountDefaultGuardrailId, workspaceId, params.id, `personal:${params.id}`),
				raw.prepare(`INSERT INTO guardrail_versions (
					id, guardrail_id, version, config_json, created_by_user_id, created_at
				) VALUES (?, ?, 1, '{}', ?, datetime('now'))`)
					.bind(accountDefaultGuardrailVersionId, accountDefaultGuardrailId, params.id),
			]);
		},

		async updateUserPlan(
			id: string,
			budget_max: number | null,
			budget_period: string,
			budget_reset_at: string | null,
			resetBudget: boolean = true,
			metadata?: string | null,
			budget_spent_override?: number | null,
			budget_base?: number | null
		): Promise<boolean> {
			const setClauses: string[] = ['budget_max = ?', 'budget_period = ?', 'budget_reset_at = ?', "updated_at = datetime('now')"];
			const bindValues: unknown[] = [
				budget_max != null ? roundGatewayMoney(budget_max) : null,
				budget_period,
				budget_reset_at ?? null,
			];
			const resetsBudgetEpoch = budget_spent_override !== undefined || resetBudget;
			if (budget_spent_override !== undefined) {
				const budgetSpentMicros = toD1BudgetSpentMicros(budget_spent_override ?? 0);
				setClauses.push('budget_spent = ?', 'budget_spent_micros = ?');
				bindValues.push(userBudgetAmount(budgetSpentMicros), budgetSpentMicros);
			} else if (resetBudget) {
				setClauses.push('budget_spent = 0', 'budget_spent_micros = 0');
			}
			if (resetsBudgetEpoch) {
				setClauses.push('budget_epoch = budget_epoch + 1', 'budget_reserved_micros = 0');
			}
			if (budget_base !== undefined) {
				setClauses.push('budget_base = ?');
				bindValues.push(budget_base != null ? roundGatewayMoney(budget_base) : 0);
			}
			if (metadata !== undefined) {
				setClauses.push('metadata = ?');
				bindValues.push(metadata);
			}
			bindValues.push(id);
			const result = await raw
				.prepare(`UPDATE users SET ${setClauses.join(', ')} WHERE id = ?`)
				.bind(...bindValues)
				.run();
			return result.meta.changes > 0;
		},

		async updateUserStatus(id: string, status: string): Promise<boolean> {
			const result = await raw
				.prepare("UPDATE users SET status = ?, updated_at = datetime('now') WHERE id = ?")
				.bind(status, id)
				.run();
			return result.meta.changes > 0;
		},

		async setUserMetadataById(id: string, metadataJson: string | null): Promise<boolean> {
			const result = await raw
				.prepare("UPDATE users SET metadata = ?, updated_at = datetime('now') WHERE id = ?")
				.bind(metadataJson, id)
				.run();
			return result.meta.changes > 0;
		},

		async setUserChargedCostFactorsById(id: string, chargedCostFactorsJson: string | null): Promise<boolean> {
			const result = await raw
				.prepare("UPDATE users SET charged_cost_factors = ?, updated_at = datetime('now') WHERE id = ?")
				.bind(chargedCostFactorsJson, id)
				.run();
			return result.meta.changes > 0;
		},

		async setUserEmailById(id: string, email: string): Promise<boolean> {
			const result = await raw
				.prepare("UPDATE users SET email = ?, updated_at = datetime('now') WHERE id = ?")
				.bind(email, id)
				.run();
			return result.meta.changes > 0;
		},

		async setUserExternalIdentityById(
			id: string,
			externalSystem: string | null,
			externalUserId: string | null
		): Promise<boolean> {
			const result = await raw
				.prepare(
					"UPDATE users SET external_system = ?, external_user_id = ?, updated_at = datetime('now') WHERE id = ?"
				)
				.bind(externalSystem, externalUserId, id)
				.run();
			return result.meta.changes > 0;
		},

		async deleteUserHard(id: string): Promise<boolean> {
			const result = await raw.prepare(`DELETE FROM users WHERE id = ?
				AND NOT EXISTS (SELECT 1 FROM guardrails guardrail
					WHERE guardrail.owner_user_id = users.id
						AND (guardrail.is_workspace_default = 1 OR guardrail.is_account_default = 1))`)
				.bind(id).run();
			return (result.meta.changes ?? 0) > 0;
		},

		async getUsersCount() {
			const row = await raw
				.prepare(
					`SELECT
				COUNT(*) as total,
				SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active
			 FROM users`
				)
				.first<{ total: number; active: number }>();
			return {
				total: Number(row?.total ?? 0),
				active: Number(row?.active ?? 0),
			};
		},
	};
}
