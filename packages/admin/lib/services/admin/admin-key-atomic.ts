import type {
	AdminKeyMutationWithAudit,
	GatewayRepositories,
	ResolvedGatewayKeyRow,
} from "@octafuse/core";
import { userBudgetAuditToInsertRowFull } from "@octafuse/core/db/user-budget-audit-mapper";
import {
	userRowToSnapshot,
	snapshotToJson,
	type UserAuditSnapshot,
} from "@octafuse/core/db/user-audit-snapshot";
import { buildMetadataAuditChange } from "./admin-profile-audit-metadata";
import { badRequest, conflict, notFound } from "./errors";
import {
	assertMetadataEditable,
	keyMetadata,
	keyName,
	keyStatus,
} from "./gateway-key-contract";
import type { JsonObject } from "./types";

type KeyPatchInput = {
	name?: string | null;
	status?: string;
	metadata?: unknown;
	metadata_replace?: unknown;
};

export async function commitAdminKeyMutation(
	repos: GatewayRepositories,
	mutation: AdminKeyMutationWithAudit
): Promise<void> {
	if (!repos.apiKeys.applyAdminKeyMutationWithAudit) {
		throw new Error("Atomic Admin Key mutation repository is unavailable");
	}
	const result = await repos.apiKeys.applyAdminKeyMutationWithAudit(mutation);
	if (result === "not_found") throw notFound("Key not found");
	if (result === "conflict") throw conflict("Key changed concurrently; retry");
}

export function expectedAdminKeyProfile(
	row: ResolvedGatewayKeyRow
): AdminKeyMutationWithAudit["expected"] {
	return {
		userId: row.user_id,
		workspaceId: row.workspace_id,
		name: row.name,
		status: row.status,
		metadata: row.metadata,
	};
}

export async function readAdminKeyAuditUser(
	repos: GatewayRepositories,
	userId: string
): Promise<UserAuditSnapshot> {
	const user = await repos.users.getById(userId);
	if (!user) throw notFound("Key not found");
	return userRowToSnapshot(user);
}

export function planAdminKeyPatch(
	row: ResolvedGatewayKeyRow,
	input: KeyPatchInput
) {
	assertMetadataEditable(row.metadata, input);
	if (input.metadata !== undefined && input.metadata_replace !== undefined)
		throw badRequest("Use either metadata or metadata_replace, not both");
	let metadataReplaceStr: string | null | undefined;
	if (input.metadata_replace !== undefined) {
		metadataReplaceStr = keyMetadata(input.metadata_replace);
	} else if (
		input.metadata !== undefined &&
		typeof input.metadata === "string"
	) {
		metadataReplaceStr = keyMetadata(input.metadata);
	}
	if (
		input.metadata !== undefined &&
		typeof input.metadata !== "string" &&
		(!input.metadata ||
			typeof input.metadata !== "object" ||
			Array.isArray(input.metadata))
	)
		throw badRequest("metadata must be a JSON object or JSON string");
	const hasMetaObjectMerge =
		input.metadata !== undefined &&
		typeof input.metadata === "object" &&
		input.metadata !== null &&
		!Array.isArray(input.metadata);
	if (hasMetaObjectMerge && metadataReplaceStr !== undefined) {
		throw badRequest(
			"Use either metadata (object merge or string replace) or metadata_replace, not both"
		);
	}
	const patch: AdminKeyMutationWithAudit["patch"] = {};
	if (input.name !== undefined) patch.name = keyName(input.name);
	if (input.status !== undefined) patch.status = keyStatus(input.status);
	let metadataOperation: "merge" | "replace" | null = null;
	let touchedKeys: string[] | undefined;
	if (hasMetaObjectMerge) {
		keyMetadata(input.metadata);
		let existing: Record<string, unknown> = {};
		if (row.metadata) {
			try {
				const parsed = JSON.parse(row.metadata) as unknown;
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
					existing = parsed as Record<string, unknown>;
			} catch {
				existing = {};
			}
		}
		const values = input.metadata as JsonObject;
		patch.metadata = keyMetadata({ ...existing, ...values });
		metadataOperation = "merge";
		touchedKeys = Object.keys(values);
	} else if (metadataReplaceStr !== undefined) {
		patch.metadata = metadataReplaceStr;
		metadataOperation = "replace";
	}
	const after = {
		name: Object.prototype.hasOwnProperty.call(patch, "name")
			? patch.name ?? null
			: row.name,
		status: Object.prototype.hasOwnProperty.call(patch, "status")
			? patch.status!
			: row.status,
		metadata: Object.prototype.hasOwnProperty.call(patch, "metadata")
			? patch.metadata ?? null
			: row.metadata,
	};
	return {
		patch,
		after,
		metadataOperation,
		touchedKeys,
		hasAnyField: Object.keys(patch).length > 0,
		nameChanged: row.name !== after.name,
		statusChanged: row.status !== after.status,
		metadataChanged: row.metadata !== after.metadata,
	};
}

export function auditAdminKeyPatch(
	row: ResolvedGatewayKeyRow,
	plan: ReturnType<typeof planAdminKeyPatch>,
	userSnapshot: UserAuditSnapshot | null,
	options: {
		actorId: string;
		reasonText: string;
		source: "admin_keys" | "admin_user_key";
	}
): AdminKeyMutationWithAudit["audit"] {
	const { nameChanged, statusChanged, metadataChanged } = plan;
	if (!nameChanged && !statusChanged && !metadataChanged) return null;
	if (!userSnapshot)
		throw new Error("Admin Key audit requires a user snapshot");
	const payload: Record<string, unknown> = {};
	if (nameChanged)
		payload.name = { from: row.name ?? null, to: plan.after.name ?? null };
	if (statusChanged)
		payload.status = {
			from: row.status ?? null,
			to: plan.after.status ?? null,
		};
	if (metadataChanged)
		payload.metadata = buildMetadataAuditChange(
			row.metadata,
			plan.after.metadata,
			plan.metadataOperation ?? "update",
			plan.touchedKeys
		);
	const isRevoked = statusChanged && plan.after.status === "revoked";
	let reasonCode = "admin_patch_key_profile";
	if (isRevoked)
		reasonCode =
			options.source === "admin_keys"
				? "admin_key_revoked"
				: "admin_user_key_revoked";
	else if (metadataChanged && !statusChanged && !nameChanged)
		reasonCode = "admin_patch_key_metadata";
	else if (statusChanged && !metadataChanged && !nameChanged)
		reasonCode = "admin_patch_key_status";
	else if (nameChanged && !metadataChanged && !statusChanged)
		reasonCode = "admin_patch_key_name";
	const spent = userSnapshot.budget_spent;
	const bmax = userSnapshot.budget_max;
	const bbase = userSnapshot.budget_base;
	const bperiod = userSnapshot.budget_period;
	const breset = userSnapshot.budget_reset_at;
	const userSnapshotJson = snapshotToJson(userSnapshot);
	return userBudgetAuditToInsertRowFull(row.user_id, {
		id: crypto.randomUUID(),
		apiKeyId: row.id,
		eventType: isRevoked ? "key_revoked" : "admin_adjust",
		actorType: "admin",
		actorId: options.actorId,
		reasonCode,
		reasonText: options.reasonText,
		beforeSpent: spent,
		deltaSpent: 0,
		afterSpent: spent,
		beforeBudgetMax: bmax,
		afterBudgetMax: bmax,
		beforeBudgetBase: bbase,
		afterBudgetBase: bbase,
		beforeBudgetPeriod: bperiod,
		afterBudgetPeriod: bperiod,
		beforeBudgetResetAt: breset,
		afterBudgetResetAt: breset,
		changePayloadMerge: JSON.stringify(payload),
		beforeUserSnapshot: userSnapshotJson,
		afterUserSnapshot: userSnapshotJson,
		changedFields: null,
		source: options.source,
		correlationId: crypto.randomUUID(),
	});
}
