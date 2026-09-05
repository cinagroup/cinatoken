import type { RowDataPacket } from 'mysql2/promise';
import type { GatewayDatabaseClient } from './database-client';
import type {
	WorkspaceAccessProjection,
	WorkspaceAccessSource,
	WorkspaceContextProjection,
	WorkspaceRole,
	WorkspaceScopeType,
	WorkspaceStatus,
} from '../workspaces';
import { defaultWorkspaceId } from '../workspaces';

type WorkspaceAccessRow = {
	id: string;
	name: string;
	slug: string;
	description: string | null;
	scope_type: WorkspaceScopeType;
	organization_id: string | null;
	organization_name: string | null;
	organization_slug: string | null;
	organization_roles_json: string;
	personal_owner_user_id: string | null;
	is_default: boolean | number;
	status: WorkspaceStatus;
	access_role: 'owner' | WorkspaceRole;
	access_source: WorkspaceAccessSource;
	created_at: string | Date;
	updated_at: string | Date;
};

function isoTimestamp(value: string | Date): string {
	if (value instanceof Date) return value.toISOString();
	const milliseconds = Date.parse(String(value));
	return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : String(value);
}

function parseOrganizationRoles(value: string): string[] {
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed) || parsed.length > 32) return [];
		const roles = parsed.filter(
			(role): role is string =>
				typeof role === 'string' && role.length > 0 && role.length <= 128,
		);
		return roles.length === parsed.length ? [...new Set(roles)].sort() : [];
	} catch {
		return [];
	}
}

function mapWorkspace(row: WorkspaceAccessRow): WorkspaceAccessProjection {
	return {
		id: row.id,
		name: row.name,
		slug: row.slug,
		description: row.description,
		scopeType: row.scope_type,
		organizationId: row.organization_id,
		organizationName: row.organization_name,
		organizationSlug: row.organization_slug,
		organizationRoles: parseOrganizationRoles(row.organization_roles_json),
		personalOwnerUserId: row.personal_owner_user_id,
		isDefault: row.is_default === true || Number(row.is_default) === 1,
		status: row.status,
		role: row.access_role,
		accessSource: row.access_source,
		createdAt: isoTimestamp(row.created_at),
		updatedAt: isoTimestamp(row.updated_at),
	};
}

const WORKSPACE_ACCESS_SELECT = `
	SELECT
		w.id, w.name, w.slug, w.description, w.scope_type,
		w.organization_id, o.name AS organization_name, o.slug AS organization_slug,
		CASE WHEN w.scope_type = 'organization' THEN COALESCE((
			SELECT organization_roles.roles_json
			FROM organization_memberships organization_roles
			WHERE organization_roles.organization_id = w.organization_id
				AND organization_roles.subject = :subject
				AND organization_roles.status = 'active'
			LIMIT 1
		), '[]') ELSE '[]' END AS organization_roles_json,
		w.personal_owner_user_id, w.is_default, w.status,
		CASE
			WHEN w.scope_type = 'personal' THEN 'owner'
			WHEN EXISTS (
				SELECT 1 FROM workspace_memberships access_admin
				WHERE access_admin.workspace_id = w.id AND access_admin.subject = :subject
					AND access_admin.status = 'active' AND access_admin.role = 'admin'
			) THEN 'admin'
			ELSE 'member'
		END AS access_role,
		CASE
			WHEN w.scope_type = 'personal' THEN 'personal_owner'
			WHEN w.is_default = :default_true THEN 'organization_default'
			ELSE 'workspace_membership'
		END AS access_source,
		w.created_at, w.updated_at
	FROM workspaces w
	LEFT JOIN organizations o ON o.id = w.organization_id
	WHERE w.status = 'active'
		AND EXISTS (
			SELECT 1 FROM users principal_identity
			WHERE principal_identity.id = :user_id
				AND principal_identity.external_system = 'cinaauth'
				AND principal_identity.external_user_id = :subject
				AND principal_identity.status = 'active'
		)
		AND (
			(w.scope_type = 'personal' AND w.personal_owner_user_id = :user_id)
			OR (
				w.scope_type = 'organization'
				AND o.status IN ('active', 'pending')
				AND EXISTS (
					SELECT 1 FROM organization_memberships organization_access
					WHERE organization_access.organization_id = w.organization_id
						AND organization_access.subject = :subject
						AND organization_access.status = 'active'
				)
				AND (
					w.is_default = :default_true
					OR EXISTS (
						SELECT 1 FROM workspace_memberships explicit_access
						WHERE explicit_access.workspace_id = w.id
							AND explicit_access.subject = :subject
							AND explicit_access.status = 'active'
					)
				)
			)
		)
		AND (:workspace_id IS NULL OR w.id = :workspace_id)
	ORDER BY
		CASE WHEN w.scope_type = 'personal' THEN 0 ELSE 1 END,
		o.name ASC, w.is_default DESC, w.name ASC, w.id ASC
`;

function d1WorkspaceAccessSql(): string {
	return WORKSPACE_ACCESS_SELECT
		.replaceAll(':subject', '?')
		.replaceAll(':user_id', '?')
		.replaceAll(':default_true', '?')
		.replaceAll(':workspace_id', '?');
}

/**
 * Idempotently provisions the personal Default workspace and every Default
 * workspace inherited through an active CinaAuth organization membership.
 */
export async function ensureDefaultWorkspacesForSubject(
	client: GatewayDatabaseClient,
	input: { userId: string; subject: string },
): Promise<void> {
	const personalWorkspaceId = defaultWorkspaceId('personal', input.userId);
	if (!input.subject || input.subject.length > 255) throw new Error('subject is invalid');

	if (client.driver === 'd1') {
		await client.raw.batch([
			client.raw.prepare(`
				INSERT OR IGNORE INTO workspaces (
					id, scope_type, personal_owner_user_id, name, slug,
					is_default, default_scope_key, status, created_by_user_id
				)
				SELECT ?, 'personal', id, 'Default', 'default', 1, ?, 'active', id
				FROM users
				WHERE id = ? AND external_system = 'cinaauth'
					AND external_user_id = ? AND status = 'active'
			`).bind(personalWorkspaceId, personalWorkspaceId, input.userId, input.subject),
			client.raw.prepare(`
				INSERT OR IGNORE INTO workspaces (
					id, scope_type, organization_id, name, slug,
					is_default, default_scope_key, status
				)
				SELECT 'organization:' || organization.id, 'organization', organization.id,
					'Default', 'default', 1, 'organization:' || organization.id, 'active'
				FROM organization_memberships membership
				JOIN organizations organization ON organization.id = membership.organization_id
				WHERE membership.subject = ? AND membership.status = 'active'
					AND organization.status IN ('active', 'pending')
					AND EXISTS (
						SELECT 1 FROM users
						WHERE id = ? AND external_system = 'cinaauth'
							AND external_user_id = ? AND status = 'active'
					)
			`).bind(input.subject, input.userId, input.subject),
			client.raw.prepare(`
				INSERT OR IGNORE INTO guardrails (
					id, workspace_id, owner_user_id, name, description, status,
					designated_version, latest_version, created_at, updated_at,
					is_workspace_default
				)
				SELECT
					lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
						substr(lower(hex(randomblob(2))), 2) || '-' ||
						substr('89ab', abs(random()) % 4 + 1, 1) ||
						substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
					workspace.id, ?, 'Workspace ' || substr(workspace.id, 1, 180) || ' Default',
					NULL, 'active', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1
				FROM workspaces workspace
				JOIN users owner ON owner.id = ? AND owner.external_system = 'cinaauth'
					AND owner.external_user_id = ? AND owner.status = 'active'
				WHERE workspace.status = 'active'
					AND (
						(workspace.scope_type = 'personal' AND workspace.personal_owner_user_id = ?)
						OR (workspace.scope_type = 'organization' AND EXISTS (
							SELECT 1 FROM organization_memberships membership
							WHERE membership.organization_id = workspace.organization_id
								AND membership.subject = ? AND membership.status = 'active'
						))
					)
					AND NOT EXISTS (
						SELECT 1 FROM guardrails existing
						WHERE existing.workspace_id = workspace.id
							AND existing.is_workspace_default = 1
					)
			`).bind(input.userId, input.userId, input.subject, input.userId, input.subject),
			client.raw.prepare(`
				INSERT OR IGNORE INTO guardrail_versions (
					id, guardrail_id, version, config_json, created_by_user_id, created_at
				)
				SELECT
					lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
						substr(lower(hex(randomblob(2))), 2) || '-' ||
						substr('89ab', abs(random()) % 4 + 1, 1) ||
						substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
					guardrail.id, 1, '{}', ?, guardrail.created_at
				FROM guardrails guardrail
				WHERE guardrail.is_workspace_default = 1
					AND guardrail.owner_user_id = ?
					AND NOT EXISTS (
						SELECT 1 FROM guardrail_versions version
						WHERE version.guardrail_id = guardrail.id AND version.version = 1
					)
			`).bind(input.userId, input.userId),
			client.raw.prepare(`
				INSERT OR IGNORE INTO guardrails (
					id, workspace_id, owner_user_id, name, description, status,
					designated_version, latest_version, created_at, updated_at,
					is_workspace_default, is_account_default, account_scope_key
				)
				SELECT
					lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
						substr(lower(hex(randomblob(2))), 2) || '-' ||
						substr('89ab', abs(random()) % 4 + 1, 1) ||
						substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
					workspace.id, ?, 'Account Default', NULL, 'active', 1, 1,
					CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0, 1,
					CASE workspace.scope_type
						WHEN 'personal' THEN 'personal:' || workspace.personal_owner_user_id
						WHEN 'organization' THEN 'organization:' || workspace.organization_id
					END
				FROM workspaces workspace
				JOIN users owner ON owner.id = ? AND owner.external_system = 'cinaauth'
					AND owner.external_user_id = ? AND owner.status = 'active'
				WHERE workspace.status = 'active'
					AND (
						(workspace.scope_type = 'personal' AND workspace.personal_owner_user_id = ?)
						OR (workspace.scope_type = 'organization' AND EXISTS (
							SELECT 1 FROM organization_memberships membership
							WHERE membership.organization_id = workspace.organization_id
								AND membership.subject = ? AND membership.status = 'active'
						))
					)
					AND workspace.id = (
						SELECT candidate.id FROM workspaces candidate
						WHERE candidate.status = 'active' AND candidate.scope_type = workspace.scope_type
							AND (
								(workspace.scope_type = 'personal' AND candidate.personal_owner_user_id = workspace.personal_owner_user_id)
								OR (workspace.scope_type = 'organization' AND candidate.organization_id = workspace.organization_id)
							)
						ORDER BY candidate.is_default DESC, candidate.created_at, candidate.id LIMIT 1
					)
			`).bind(input.userId, input.userId, input.subject, input.userId, input.subject),
			client.raw.prepare(`
				INSERT OR IGNORE INTO guardrail_versions (
					id, guardrail_id, version, config_json, created_by_user_id, created_at
				)
				SELECT
					lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
						substr(lower(hex(randomblob(2))), 2) || '-' ||
						substr('89ab', abs(random()) % 4 + 1, 1) ||
						substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
					guardrail.id, 1, '{}', guardrail.owner_user_id, guardrail.created_at
				FROM guardrails guardrail
				WHERE guardrail.is_account_default = 1 AND guardrail.owner_user_id = ?
					AND NOT EXISTS (
						SELECT 1 FROM guardrail_versions version
						WHERE version.guardrail_id = guardrail.id AND version.version = 1
					)
			`).bind(input.userId),
		]);
		return;
	}

	if (client.driver === 'postgres') {
		await client.raw.begin(async (transaction) => {
			await transaction`
				INSERT INTO workspaces (
					id, scope_type, personal_owner_user_id, name, slug,
					is_default, default_scope_key, status, created_by_user_id
				)
				SELECT ${personalWorkspaceId}, 'personal', id, 'Default', 'default',
					TRUE, ${personalWorkspaceId}, 'active', id
				FROM users
				WHERE id = ${input.userId} AND external_system = 'cinaauth'
					AND external_user_id = ${input.subject} AND status = 'active'
				ON CONFLICT (id) DO NOTHING
			`;
			await transaction`
				INSERT INTO workspaces (
					id, scope_type, organization_id, name, slug,
					is_default, default_scope_key, status
				)
				SELECT 'organization:' || organization.id, 'organization', organization.id,
					'Default', 'default', TRUE, 'organization:' || organization.id, 'active'
				FROM organization_memberships membership
				JOIN organizations organization ON organization.id = membership.organization_id
				WHERE membership.subject = ${input.subject} AND membership.status = 'active'
					AND organization.status IN ('active', 'pending')
					AND EXISTS (
						SELECT 1 FROM users
						WHERE id = ${input.userId} AND external_system = 'cinaauth'
							AND external_user_id = ${input.subject} AND status = 'active'
					)
				ON CONFLICT (id) DO NOTHING
			`;
			await transaction`
				INSERT INTO guardrails (
					id, workspace_id, owner_user_id, name, description, status,
					designated_version, latest_version, created_at, updated_at,
					is_workspace_default
				)
				SELECT
					substr(md5(workspace.id || ':workspace-default-guardrail'), 1, 8) || '-' ||
						substr(md5(workspace.id || ':workspace-default-guardrail'), 9, 4) || '-5' ||
						substr(md5(workspace.id || ':workspace-default-guardrail'), 14, 3) || '-8' ||
						substr(md5(workspace.id || ':workspace-default-guardrail'), 18, 3) || '-' ||
						substr(md5(workspace.id || ':workspace-default-guardrail'), 21, 12),
					workspace.id, ${input.userId}, 'Workspace ' || left(workspace.id, 180) || ' Default',
					NULL, 'active', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, TRUE
				FROM workspaces workspace
				JOIN users owner ON owner.id = ${input.userId}
					AND owner.external_system = 'cinaauth'
					AND owner.external_user_id = ${input.subject} AND owner.status = 'active'
				WHERE workspace.status = 'active'
					AND (
						(workspace.scope_type = 'personal' AND workspace.personal_owner_user_id = ${input.userId})
						OR (workspace.scope_type = 'organization' AND EXISTS (
							SELECT 1 FROM organization_memberships membership
							WHERE membership.organization_id = workspace.organization_id
								AND membership.subject = ${input.subject} AND membership.status = 'active'
						))
					)
				ON CONFLICT DO NOTHING
			`;
			await transaction`
				INSERT INTO guardrail_versions (
					id, guardrail_id, version, config_json, created_by_user_id, created_at
				)
				SELECT
					substr(md5(guardrail.id || ':version:1'), 1, 8) || '-' ||
						substr(md5(guardrail.id || ':version:1'), 9, 4) || '-5' ||
						substr(md5(guardrail.id || ':version:1'), 14, 3) || '-8' ||
						substr(md5(guardrail.id || ':version:1'), 18, 3) || '-' ||
						substr(md5(guardrail.id || ':version:1'), 21, 12),
					guardrail.id, 1, '{}', ${input.userId}, guardrail.created_at
				FROM guardrails guardrail
				WHERE guardrail.is_workspace_default
					AND guardrail.owner_user_id = ${input.userId}
				ON CONFLICT (guardrail_id, version) DO NOTHING
			`;
			await transaction`
				INSERT INTO guardrails (
					id, workspace_id, owner_user_id, name, description, status,
					designated_version, latest_version, created_at, updated_at,
					is_workspace_default, is_account_default, account_scope_key
				)
				SELECT
					substr(md5(account.account_scope_key || ':account-default-guardrail'), 1, 8) || '-' ||
						substr(md5(account.account_scope_key || ':account-default-guardrail'), 9, 4) || '-5' ||
						substr(md5(account.account_scope_key || ':account-default-guardrail'), 14, 3) || '-8' ||
						substr(md5(account.account_scope_key || ':account-default-guardrail'), 18, 3) || '-' ||
						substr(md5(account.account_scope_key || ':account-default-guardrail'), 21, 12),
					account.workspace_id, ${input.userId}, 'Account Default', NULL, 'active', 1, 1,
					CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, FALSE, TRUE, account.account_scope_key
				FROM (
					SELECT DISTINCT ON (account_scope_key) workspace.id AS workspace_id, account_scope_key
					FROM (
						SELECT workspace.*,
							CASE workspace.scope_type
								WHEN 'personal' THEN 'personal:' || workspace.personal_owner_user_id
								WHEN 'organization' THEN 'organization:' || workspace.organization_id
							END AS account_scope_key
						FROM workspaces workspace
						WHERE workspace.status = 'active' AND (
							(workspace.scope_type = 'personal' AND workspace.personal_owner_user_id = ${input.userId})
							OR (workspace.scope_type = 'organization' AND EXISTS (
								SELECT 1 FROM organization_memberships membership
								WHERE membership.organization_id = workspace.organization_id
									AND membership.subject = ${input.subject} AND membership.status = 'active'
							))
						)
					) workspace
					ORDER BY account_scope_key, workspace.is_default DESC, workspace.created_at, workspace.id
				) account
				ON CONFLICT DO NOTHING
			`;
			await transaction`
				INSERT INTO guardrail_versions (
					id, guardrail_id, version, config_json, created_by_user_id, created_at
				)
				SELECT
					substr(md5(guardrail.id || ':version:1'), 1, 8) || '-' ||
						substr(md5(guardrail.id || ':version:1'), 9, 4) || '-5' ||
						substr(md5(guardrail.id || ':version:1'), 14, 3) || '-8' ||
						substr(md5(guardrail.id || ':version:1'), 18, 3) || '-' ||
						substr(md5(guardrail.id || ':version:1'), 21, 12),
					guardrail.id, 1, '{}', guardrail.owner_user_id, guardrail.created_at
				FROM guardrails guardrail
				WHERE guardrail.is_account_default AND guardrail.owner_user_id = ${input.userId}
				ON CONFLICT (guardrail_id, version) DO NOTHING
			`;
		});
		return;
	}

	const connection = await client.raw.getConnection();
	try {
		await connection.beginTransaction();
		await connection.execute(`
			INSERT INTO workspaces (
				id, scope_type, personal_owner_user_id, name, slug,
				is_default, default_scope_key, status, created_by_user_id
			)
			SELECT ?, 'personal', id, 'Default', 'default', TRUE, ?, 'active', id
			FROM users
			WHERE id = ? AND external_system = 'cinaauth'
				AND external_user_id = ? AND status = 'active'
			ON DUPLICATE KEY UPDATE id = id
		`, [personalWorkspaceId, personalWorkspaceId, input.userId, input.subject]);
		await connection.execute(`
			INSERT INTO workspaces (
				id, scope_type, organization_id, name, slug,
				is_default, default_scope_key, status
			)
			SELECT CONCAT('organization:', organization.id), 'organization', organization.id,
				'Default', 'default', TRUE, CONCAT('organization:', organization.id), 'active'
			FROM organization_memberships membership
			JOIN organizations organization ON organization.id = membership.organization_id
			WHERE membership.subject = ? AND membership.status = 'active'
				AND organization.status IN ('active', 'pending')
				AND EXISTS (
					SELECT 1 FROM users
					WHERE id = ? AND external_system = 'cinaauth'
						AND external_user_id = ? AND status = 'active'
				)
			ON DUPLICATE KEY UPDATE id = id
		`, [input.subject, input.userId, input.subject]);
		await connection.execute(`
			INSERT IGNORE INTO guardrails (
				id, workspace_id, workspace_key, owner_user_id, name, description, status,
				designated_version, latest_version, created_at, updated_at,
				is_workspace_default
			)
			SELECT UUID(), workspace.id, SHA2(workspace.id, 256), ?,
				CONCAT('Workspace ', LEFT(workspace.id, 180), ' Default'), NULL,
				'active', 1, 1, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6), TRUE
			FROM workspaces workspace
			JOIN users owner ON owner.id = ? AND owner.external_system = 'cinaauth'
				AND owner.external_user_id = ? AND owner.status = 'active'
			WHERE workspace.status = 'active'
				AND (
					(workspace.scope_type = 'personal' AND workspace.personal_owner_user_id = ?)
					OR (workspace.scope_type = 'organization' AND EXISTS (
						SELECT 1 FROM organization_memberships membership
						WHERE membership.organization_id = workspace.organization_id
							AND membership.subject = ? AND membership.status = 'active'
					))
				)
		`, [input.userId, input.userId, input.subject, input.userId, input.subject]);
		await connection.execute(`
			INSERT IGNORE INTO guardrail_versions (
				id, guardrail_id, version, config_json, created_by_user_id, created_at
			)
			SELECT UUID(), guardrail.id, 1, '{}', ?, guardrail.created_at
			FROM guardrails guardrail
			WHERE guardrail.is_workspace_default = TRUE AND guardrail.owner_user_id = ?
		`, [input.userId, input.userId]);
		await connection.execute(`
			INSERT IGNORE INTO guardrails (
				id, workspace_id, workspace_key, owner_user_id, name, description, status,
				designated_version, latest_version, created_at, updated_at,
				is_workspace_default, is_account_default, account_scope_key
			)
			SELECT UUID(), workspace.id, SHA2(workspace.id, 256), ?, 'Account Default', NULL,
				'active', 1, 1, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6), FALSE, TRUE,
				IF(workspace.scope_type = 'personal',
					CONCAT('personal:', workspace.personal_owner_user_id),
					CONCAT('organization:', workspace.organization_id))
			FROM workspaces workspace
			JOIN users owner ON owner.id = ? AND owner.external_system = 'cinaauth'
				AND owner.external_user_id = ? AND owner.status = 'active'
			WHERE workspace.status = 'active'
				AND (
					(workspace.scope_type = 'personal' AND workspace.personal_owner_user_id = ?)
					OR (workspace.scope_type = 'organization' AND EXISTS (
						SELECT 1 FROM organization_memberships membership
						WHERE membership.organization_id = workspace.organization_id
							AND membership.subject = ? AND membership.status = 'active'
					))
				)
				AND workspace.id = (
					SELECT candidate.id FROM workspaces candidate
					WHERE candidate.status = 'active' AND candidate.scope_type = workspace.scope_type
						AND (
							(workspace.scope_type = 'personal' AND candidate.personal_owner_user_id = workspace.personal_owner_user_id)
							OR (workspace.scope_type = 'organization' AND candidate.organization_id = workspace.organization_id)
						)
					ORDER BY candidate.is_default DESC, candidate.created_at, candidate.id LIMIT 1
				)
		`, [input.userId, input.userId, input.subject, input.userId, input.subject]);
		await connection.execute(`
			INSERT IGNORE INTO guardrail_versions (
				id, guardrail_id, version, config_json, created_by_user_id, created_at
			)
			SELECT UUID(), guardrail.id, 1, '{}', guardrail.owner_user_id, guardrail.created_at
			FROM guardrails guardrail
			WHERE guardrail.is_account_default = TRUE AND guardrail.owner_user_id = ?
		`, [input.userId]);
		await connection.commit();
	} catch (error) {
		await connection.rollback().catch(() => undefined);
		throw error;
	} finally {
		connection.release();
	}
}

async function queryD1(
	client: Extract<GatewayDatabaseClient, { driver: 'd1' }>,
	input: { userId: string; subject: string; workspaceId?: string },
): Promise<WorkspaceAccessProjection[]> {
	const result = await client.raw.prepare(d1WorkspaceAccessSql()).bind(
		input.subject,
		input.subject,
		1,
		input.userId,
		input.subject,
		input.userId,
		input.subject,
		1,
		input.subject,
		input.workspaceId ?? null,
		input.workspaceId ?? null,
	).all<WorkspaceAccessRow>();
	return (result.results ?? []).map(mapWorkspace);
}

async function queryPostgres(
	client: Extract<GatewayDatabaseClient, { driver: 'postgres' }>,
	input: { userId: string; subject: string; workspaceId?: string },
): Promise<WorkspaceAccessProjection[]> {
	const sql = WORKSPACE_ACCESS_SELECT
		.replaceAll(':subject', '$1')
		.replaceAll(':user_id', '$2')
		.replaceAll(':default_true', 'TRUE')
		// PostgreSQL cannot infer the type of a null-only parameter in
		// `$3 IS NULL`. Cast every occurrence so listing all Workspaces with a
		// null preference is valid as well as filtering by an explicit id.
		.replaceAll(':workspace_id', '$3::text');
	const rows = await client.raw.unsafe<WorkspaceAccessRow[]>(sql, [
		input.subject,
		input.userId,
		input.workspaceId ?? null,
	]);
	return rows.map(mapWorkspace);
}

async function queryMySql(
	client: Extract<GatewayDatabaseClient, { driver: 'mysql' }>,
	input: { userId: string; subject: string; workspaceId?: string },
): Promise<WorkspaceAccessProjection[]> {
	const sql = WORKSPACE_ACCESS_SELECT
		.replaceAll(':subject', '?')
		.replaceAll(':user_id', '?')
		.replaceAll(':default_true', 'TRUE')
		.replaceAll(':workspace_id', '?');
	const [rows] = await client.raw.execute<(WorkspaceAccessRow & RowDataPacket)[]>(sql, [
		input.subject,
		input.subject,
		input.userId,
		input.subject,
		input.userId,
		input.subject,
		input.subject,
		input.workspaceId ?? null,
		input.workspaceId ?? null,
	]);
	return rows.map(mapWorkspace);
}

/** List active workspaces authorized for this exact local user + CinaAuth subject pair. */
export async function listAccessibleWorkspacesForSubject(
	client: GatewayDatabaseClient,
	input: { userId: string; subject: string },
): Promise<WorkspaceAccessProjection[]> {
	await ensureDefaultWorkspacesForSubject(client, input);
	if (client.driver === 'd1') return queryD1(client, input);
	if (client.driver === 'postgres') return queryPostgres(client, input);
	return queryMySql(client, input);
}

/**
 * Resolves the current Workspace from an untrusted browser preference.
 * Authorization is always recomputed from the exact local user + CinaAuth
 * subject pair. An inaccessible/stale preference falls back to the personal
 * Default Workspace and is never treated as proof of access.
 */
export async function resolveWorkspaceContextForSubject(
	client: GatewayDatabaseClient,
	input: { userId: string; subject: string; preferredWorkspaceId?: string | null },
): Promise<WorkspaceContextProjection> {
	const workspaces = await listAccessibleWorkspacesForSubject(client, input);
	if (workspaces.length === 0) {
		throw new Error('No accessible Workspace exists for the authenticated principal');
	}
	const preferredWorkspaceId = input.preferredWorkspaceId?.trim() || null;
	const preferred = preferredWorkspaceId
		? workspaces.find((workspace) => workspace.id === preferredWorkspaceId)
		: undefined;
	const personalDefaultId = defaultWorkspaceId('personal', input.userId);
	const currentWorkspace = preferred
		?? workspaces.find((workspace) => workspace.id === personalDefaultId)
		?? workspaces.find((workspace) => workspace.isDefault)
		?? workspaces[0]!;
	return {
		workspaces,
		currentWorkspace,
		preferredWorkspaceAvailable: preferredWorkspaceId === null || preferred !== undefined,
	};
}

/** Resolve one workspace without trusting a browser-supplied id. */
export async function getAccessibleWorkspaceForSubject(
	client: GatewayDatabaseClient,
	input: { userId: string; subject: string; workspaceId: string },
): Promise<WorkspaceAccessProjection | null> {
	if (!input.workspaceId || input.workspaceId.length > 600) return null;
	await ensureDefaultWorkspacesForSubject(client, input);
	const rows = client.driver === 'd1'
		? await queryD1(client, input)
		: client.driver === 'postgres'
			? await queryPostgres(client, input)
			: await queryMySql(client, input);
	return rows[0] ?? null;
}
