/**
 * Postgres：`users`。
 */
import { and, asc, count, desc, eq, gt, isNotNull, isNull, like, lte, sql } from 'drizzle-orm';
import type { UserRow } from '../../types';
import { roundGatewayMoney } from '../../lib/money-precision';
import type { PostgresDatabaseClient } from '../../storage/database-client';
import type { UsersRepository } from '../../storage/gateway-repository-interfaces';
import {
	guardrailsTable as pgGuardrailsTable,
	guardrailVersionsTable as pgGuardrailVersionsTable,
	usersTable as pgUsersTable,
	workspacesTable as pgWorkspacesTable,
} from '../../storage/drizzle/schema.pg';
import type { InsertUserParams, UserMaxBudgetFilter } from '../users-types';
import { defaultWorkspaceId } from '../../workspaces';
import {
	DEFAULT_USER_LIST_ORDER,
	DEFAULT_USER_LIST_SORT,
	type UserListSortField,
	type UserListSortOrder,
} from '../users-list-sort';
import { parseMoney } from '../../storage/critical-write-paths-utils';

function userListOrderByClauses(sort: UserListSortField, order: UserListSortOrder) {
	const isAsc = order === 'asc';
	const tie = isAsc ? asc(pgUsersTable.createdAt) : desc(pgUsersTable.createdAt);
	if (sort === 'budget_reset_at') {
		const col = pgUsersTable.budgetResetAt;
		const primary = isAsc ? sql`${col} ASC NULLS LAST` : sql`${col} DESC NULLS FIRST`;
		return [primary, tie];
	}
	if (sort === 'budget_max') {
		const col = pgUsersTable.budgetMax;
		const primary = isAsc ? sql`${col} ASC NULLS LAST` : sql`${col} DESC NULLS FIRST`;
		return [primary, tie];
	}
	if (sort === 'budget_spent') {
		return [isAsc ? asc(pgUsersTable.budgetSpent) : desc(pgUsersTable.budgetSpent), tie];
	}
	if (sort === 'budget_base') {
		return [isAsc ? asc(pgUsersTable.budgetBase) : desc(pgUsersTable.budgetBase), tie];
	}
	return [isAsc ? asc(pgUsersTable.createdAt) : desc(pgUsersTable.createdAt)];
}

function mapPgUserRow(r: {
	id: string;
	email: string | null;
	budgetMax: string | null;
	budgetBase: string;
	budgetSpent: string;
	budgetPeriod: string;
	budgetResetAt: string | null;
	budgetEpoch: number;
	budgetReservedMicros: number;
	status: string;
	metadata: string | null;
	chargedCostFactors: string | null;
	externalSystem: string | null;
	externalUserId: string | null;
	createdAt: string;
	updatedAt: string;
}): UserRow {
	return {
		id: r.id,
		email: r.email ?? '',
		budget_max: r.budgetMax == null ? null : parseMoney(r.budgetMax),
		budget_base: parseMoney(r.budgetBase),
		budget_spent: parseMoney(r.budgetSpent),
		budget_period: r.budgetPeriod,
		budget_reset_at: r.budgetResetAt,
		budget_epoch: Number(r.budgetEpoch),
		budget_reserved_micros: Number(r.budgetReservedMicros),
		status: r.status,
		metadata: r.metadata,
		charged_cost_factors: r.chargedCostFactors ?? null,
		external_system: r.externalSystem,
		external_user_id: r.externalUserId,
		created_at: r.createdAt,
		updated_at: r.updatedAt,
	};
}

export function createPostgresUsersRepository(db: PostgresDatabaseClient): UsersRepository {
	const drizzle = db.drizzle;
	return {
		async getById(id: string): Promise<UserRow | null> {
			const rows = await drizzle.select().from(pgUsersTable).where(eq(pgUsersTable.id, id)).limit(1);
			return rows[0] ? mapPgUserRow(rows[0]) : null;
		},

		async getByExternalPair(externalSystem: string, externalUserId: string): Promise<UserRow | null> {
			const rows = await drizzle
				.select()
				.from(pgUsersTable)
				.where(and(eq(pgUsersTable.externalSystem, externalSystem), eq(pgUsersTable.externalUserId, externalUserId)))
				.limit(1);
			return rows[0] ? mapPgUserRow(rows[0]) : null;
		},

		async listByEmail(email: string): Promise<UserRow[]> {
			const rows = await drizzle
				.select()
				.from(pgUsersTable)
				.where(eq(pgUsersTable.email, email))
				.orderBy(desc(pgUsersTable.createdAt));
			return rows.map(mapPgUserRow);
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
			const conditions = [];
			if (options?.email) conditions.push(like(pgUsersTable.email, `%${options.email}%`));
			if (options?.externalSystem) conditions.push(eq(pgUsersTable.externalSystem, options.externalSystem));
			if (options?.externalUserId) conditions.push(eq(pgUsersTable.externalUserId, options.externalUserId));
			if (options?.status) conditions.push(eq(pgUsersTable.status, options.status));
			if (options?.maxBudget === 'positive') {
				conditions.push(and(isNotNull(pgUsersTable.budgetMax), gt(pgUsersTable.budgetMax, '0'))!);
			} else if (options?.maxBudget === 'zero_or_negative') {
				conditions.push(and(isNotNull(pgUsersTable.budgetMax), lte(pgUsersTable.budgetMax, '0'))!);
			} else if (options?.maxBudget === 'null') {
				conditions.push(isNull(pgUsersTable.budgetMax));
			}
			const whereExpr = conditions.length > 0 ? and(...conditions) : undefined;
			let countQ = drizzle.select({ total: count() }).from(pgUsersTable);
			if (whereExpr) countQ = countQ.where(whereExpr) as typeof countQ;
			const total = Number((await countQ)[0]?.total ?? 0);
			const sort = options?.sort ?? DEFAULT_USER_LIST_SORT;
			const order = options?.order ?? DEFAULT_USER_LIST_ORDER;
			let listQ = drizzle.select().from(pgUsersTable);
			if (whereExpr) listQ = listQ.where(whereExpr) as typeof listQ;
			const rows = await listQ.orderBy(...userListOrderByClauses(sort, order)).limit(pageSize).offset(offset);
			return { users: rows.map(mapPgUserRow), total };
		},

		async createUser(params: InsertUserParams): Promise<void> {
			const now = new Date().toISOString();
			const budgetMax = params.budgetMax != null ? String(roundGatewayMoney(params.budgetMax)) : null;
			const budgetBase = String(params.budgetBase != null ? roundGatewayMoney(params.budgetBase) : 0);
			const budgetSpent = String(params.budgetSpent != null ? roundGatewayMoney(params.budgetSpent) : 0);
			const workspaceId = defaultWorkspaceId('personal', params.id);
			const defaultGuardrailId = crypto.randomUUID();
			const accountDefaultGuardrailId = crypto.randomUUID();
			await drizzle.transaction(async (tx) => {
				await tx.insert(pgUsersTable).values({
					id: params.id,
					email: params.email,
					budgetMax,
					budgetBase,
					budgetSpent,
					budgetPeriod: params.budgetPeriod ?? 'none',
					budgetResetAt: params.budgetResetAt ?? null,
					status: params.status ?? 'active',
					metadata: params.metadata ?? null,
					chargedCostFactors: params.chargedCostFactors ?? null,
					externalSystem: params.externalSystem ?? null,
					externalUserId: params.externalUserId ?? null,
					createdAt: now,
					updatedAt: now,
				});
				await tx.insert(pgWorkspacesTable).values({
					id: workspaceId,
					scopeType: 'personal',
					organizationId: null,
					personalOwnerUserId: params.id,
					name: 'Default',
					slug: 'default',
					description: null,
					isDefault: true,
					defaultScopeKey: workspaceId,
					status: 'active',
					settingsJson: null,
					createdByUserId: params.id,
					createdAt: now,
					updatedAt: now,
				});
				await tx.insert(pgGuardrailsTable).values({
					id: defaultGuardrailId,
					workspaceId,
					ownerUserId: params.id,
					name: `Workspace ${workspaceId.slice(0, 180)} Default`,
					description: null,
					status: 'active',
					isWorkspaceDefault: true,
					designatedVersion: 1,
					latestVersion: 1,
					createdAt: now,
					updatedAt: now,
				});
				await tx.insert(pgGuardrailVersionsTable).values({
					id: crypto.randomUUID(),
					guardrailId: defaultGuardrailId,
					version: 1,
					configJson: '{}',
					createdByUserId: params.id,
					createdAt: now,
				});
				await tx.insert(pgGuardrailsTable).values({
					id: accountDefaultGuardrailId,
					workspaceId,
					ownerUserId: params.id,
					name: 'Account Default',
					description: null,
					status: 'active',
					isWorkspaceDefault: false,
					isAccountDefault: true,
					accountScopeKey: `personal:${params.id}`,
					designatedVersion: 1,
					latestVersion: 1,
					createdAt: now,
					updatedAt: now,
				});
				await tx.insert(pgGuardrailVersionsTable).values({
					id: crypto.randomUUID(),
					guardrailId: accountDefaultGuardrailId,
					version: 1,
					configJson: '{}',
					createdByUserId: params.id,
					createdAt: now,
				});
			});
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
			const now = new Date().toISOString();
			const baseSet: Record<string, unknown> = {
				budgetMax: budget_max != null ? String(roundGatewayMoney(budget_max)) : null,
				budgetPeriod: budget_period,
				budgetResetAt: budget_reset_at,
				updatedAt: now,
			};
			if (budget_base !== undefined) {
				baseSet.budgetBase = String(budget_base != null ? roundGatewayMoney(budget_base) : 0);
			}
			if (budget_spent_override !== undefined) {
				const updated = await drizzle
					.update(pgUsersTable)
					.set({
						...baseSet,
						budgetSpent: String(roundGatewayMoney(budget_spent_override ?? 0)),
						budgetEpoch: sql`${pgUsersTable.budgetEpoch} + 1`,
						budgetReservedMicros: 0,
						...(metadata !== undefined ? { metadata } : {}),
					})
					.where(eq(pgUsersTable.id, id))
					.returning({ id: pgUsersTable.id });
				return updated.length > 0;
			}
			if (resetBudget) {
				const updated = await drizzle
					.update(pgUsersTable)
					.set({
						...baseSet,
						budgetSpent: '0',
						budgetEpoch: sql`${pgUsersTable.budgetEpoch} + 1`,
						budgetReservedMicros: 0,
						...(metadata !== undefined ? { metadata } : {}),
					})
					.where(eq(pgUsersTable.id, id))
					.returning({ id: pgUsersTable.id });
				return updated.length > 0;
			}
			const updated = await drizzle
				.update(pgUsersTable)
				.set({
					...baseSet,
					...(metadata !== undefined ? { metadata } : {}),
				})
				.where(eq(pgUsersTable.id, id))
				.returning({ id: pgUsersTable.id });
			return updated.length > 0;
		},

		async updateUserStatus(id: string, status: string): Promise<boolean> {
			const now = new Date().toISOString();
			const updated = await drizzle
				.update(pgUsersTable)
				.set({ status, updatedAt: now })
				.where(eq(pgUsersTable.id, id))
				.returning({ id: pgUsersTable.id });
			return updated.length > 0;
		},

		async setUserMetadataById(id: string, metadataJson: string | null): Promise<boolean> {
			const now = new Date().toISOString();
			const updated = await drizzle
				.update(pgUsersTable)
				.set({ metadata: metadataJson, updatedAt: now })
				.where(eq(pgUsersTable.id, id))
				.returning({ id: pgUsersTable.id });
			return updated.length > 0;
		},

		async setUserChargedCostFactorsById(id: string, chargedCostFactorsJson: string | null): Promise<boolean> {
			const now = new Date().toISOString();
			const updated = await drizzle
				.update(pgUsersTable)
				.set({ chargedCostFactors: chargedCostFactorsJson, updatedAt: now })
				.where(eq(pgUsersTable.id, id))
				.returning({ id: pgUsersTable.id });
			return updated.length > 0;
		},

		async setUserEmailById(id: string, email: string): Promise<boolean> {
			const now = new Date().toISOString();
			const updated = await drizzle
				.update(pgUsersTable)
				.set({ email, updatedAt: now })
				.where(eq(pgUsersTable.id, id))
				.returning({ id: pgUsersTable.id });
			return updated.length > 0;
		},

		async setUserExternalIdentityById(
			id: string,
			externalSystem: string | null,
			externalUserId: string | null
		): Promise<boolean> {
			const now = new Date().toISOString();
			const updated = await drizzle
				.update(pgUsersTable)
				.set({ externalSystem, externalUserId, updatedAt: now })
				.where(eq(pgUsersTable.id, id))
				.returning({ id: pgUsersTable.id });
			return updated.length > 0;
		},

		async deleteUserHard(id: string): Promise<boolean> {
			const rows = await db.raw.unsafe<Array<{ id: string }>>(`DELETE FROM users subject
				WHERE subject.id = $1 AND NOT EXISTS (
					SELECT 1 FROM guardrails guardrail
					WHERE guardrail.owner_user_id = subject.id
						AND (guardrail.is_workspace_default OR guardrail.is_account_default)
				) RETURNING subject.id`, [id]);
			return rows.length > 0;
		},

		async getUsersCount() {
			const row = await drizzle
				.select({
					total: count(),
					active: sql<number>`SUM(CASE WHEN ${pgUsersTable.status} = 'active' THEN 1 ELSE 0 END)`,
				})
				.from(pgUsersTable);
			return {
				total: Number(row[0]?.total ?? 0),
				active: Number(row[0]?.active ?? 0),
			};
		},
	};
}
