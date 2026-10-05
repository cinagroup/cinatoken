import {
	sharedKeyAdminRevision,
	sharedKeyStateExpectation,
	type GatewayRepositories,
	type SharedKeyRow,
	type AdminSharedKeysRepository,
} from "@octafuse/core";
import { BILLING_CURRENCY_KEY } from "@octafuse/core/lib/billing-currency";
import type { AdminBindings } from "@/lib/admin-env";
import type { AdminPrincipal } from "@/lib/admin-principal";
import { isSharedKeyEarningHistoryDeleteError } from "@/lib/shared-key-history-error";
import { projectCurrentSellerCreditedUsage } from "@/lib/shared-key-credited-usage-reader";
import { assertExpectedConsoleSubject } from "./expected-console-subject";
import {
	encodeSharedKeyAdminCursor,
	SharedKeyAdminError,
	sharedKeyAdminActor,
	sharedKeyAdminAuditQuery,
	sharedKeyAdminId,
	sharedKeyAdminListQuery,
	sharedKeyAdminQuery,
	sharedKeyAdminWriteBody,
} from "./shared-key-admin-contract";
import {
	projectAdminSharedKey,
	projectAdminSharedKeyAudit,
	sharedKeyAdminContext,
	sharedKeyAdminCurrencyReference,
	type AdminSharedKeyDetail,
	type AdminSharedKeysOverview,
	type SafeAdminSharedKeyRow,
	type SharedKeyAdminStatisticsBasis,
} from "./shared-key-admin-dto";

function repositoryMethod<K extends keyof AdminSharedKeysRepository>(
	repos: GatewayRepositories,
	name: K
): AdminSharedKeysRepository[K] {
	const method = repos.sharedKeys[name];
	if (typeof method !== "function")
		throw new SharedKeyAdminError(
			503,
			"shared_key_governance_unavailable",
			"Atomic Shared Key governance storage is unavailable"
		);
	return method.bind(repos.sharedKeys) as AdminSharedKeysRepository[K];
}
function stateConflict(): never {
	throw new SharedKeyAdminError(
		409,
		"shared_key_state_conflict",
		"Shared key state changed or requires seller validation; reload before retrying"
	);
}
function notFound(): never {
	throw new SharedKeyAdminError(404, "shared_key_not_found", "Not found");
}
function invalidStorage(): never {
	throw new Error("Invalid Shared Key storage result");
}

async function safeRows(
	repos: GatewayRepositories,
	rows: SharedKeyRow[],
	bindings: AdminBindings
): Promise<SafeAdminSharedKeyRow[]> {
	const reviewed = bindings.SHARED_KEY_CREDITED_USAGE_READER === "reviewed-v1";
	const projected = reviewed
		? await projectCurrentSellerCreditedUsage(repos, rows)
		: rows;
	const statisticsBasis: SharedKeyAdminStatisticsBasis = reviewed
		? "reviewed_credited_usage"
		: "legacy_cached_projection";
	const material = rows.flatMap((row) => [row.apiKey, row.keyFingerprint]);
	if (material.some((value) => typeof value !== "string")) invalidStorage();
	const sellers = new Map<string, string | null>();
	for (const row of rows) {
		if (!sellers.has(row.sellerUserId)) {
			const seller = await repos.users.getById(row.sellerUserId);
			if (
				seller &&
				(seller.id !== row.sellerUserId ||
					(seller.email !== null && typeof seller.email !== "string"))
			)
				invalidStorage();
			sellers.set(row.sellerUserId, seller?.email ?? null);
		}
	}
	return Promise.all(
		projected.map((row) =>
			projectAdminSharedKey(
				row,
				sellers.get(row.sellerUserId) ?? null,
				material,
				statisticsBasis
			)
		)
	);
}
async function reference(repos: GatewayRepositories) {
	// Do not use the normalizer's USD fallback or imply historic quotes used this value.
	return sharedKeyAdminCurrencyReference(
		await repos.systemConfig.getConfig(BILLING_CURRENCY_KEY)
	);
}

export async function listAdminSharedKeys(
	repos: GatewayRepositories,
	principal: AdminPrincipal,
	bindings: AdminBindings,
	url: string,
	legacy = false
): Promise<AdminSharedKeysOverview> {
	sharedKeyAdminActor(principal, false);
	const query = sharedKeyAdminListQuery(url, legacy);
	const list = repositoryMethod(repos, "listAdminSharedKeys");
	const { keys, total } = await list(query);
	if (
		!Array.isArray(keys) ||
		keys.length > query.pageSize ||
		!Number.isSafeInteger(total) ||
		total < 0 ||
		total < keys.length ||
		new Set(keys.map((row) => row.id)).size !== keys.length
	)
		invalidStorage();
	for (const row of keys)
		if (
			(query.status !== undefined && row.status !== query.status) ||
			(query.channelType !== undefined &&
				row.channelType !== query.channelType) ||
			(query.sellerUserId !== undefined &&
				row.sellerUserId !== query.sellerUserId)
		)
			invalidStorage();
	const items = await safeRows(repos, keys, bindings);
	return {
		items,
		total,
		page: query.page,
		page_size: query.pageSize,
		hasMore: query.page * query.pageSize < total,
		...sharedKeyAdminContext(await reference(repos), principal),
	};
}

export async function getAdminSharedKeyDetail(
	repos: GatewayRepositories,
	principal: AdminPrincipal,
	bindings: AdminBindings,
	rawId: string,
	url: string
): Promise<AdminSharedKeyDetail> {
	sharedKeyAdminActor(principal, false);
	sharedKeyAdminQuery(url, []);
	const id = sharedKeyAdminId(rawId);
	const row = await repositoryMethod(repos, "getAdminSharedKeyById")(id);
	if (!row) notFound();
	if (row.id !== id) invalidStorage();
	const [safe] = await safeRows(repos, [row], bindings);
	return {
		...safe,
		...sharedKeyAdminContext(await reference(repos), principal),
	};
}

export async function getAdminSharedKeyAudit(
	repos: GatewayRepositories,
	principal: AdminPrincipal,
	rawId: string,
	url: string
) {
	sharedKeyAdminActor(principal, false);
	const id = sharedKeyAdminId(rawId);
	const query = sharedKeyAdminAuditQuery(url, id);
	const list = repositoryMethod(repos, "listSharedKeyAdminAudit");
	// Audit rows have no parent FK; deletion must not make their history unreadable.
	const rows = await list(id, { limit: query.pageSize, before: query.before });
	if (
		!Array.isArray(rows) ||
		rows.length > query.pageSize ||
		new Set(rows.map((row) => row.id)).size !== rows.length
	)
		invalidStorage();
	const entries = rows.map((row) => projectAdminSharedKeyAudit(row, id));
	const order = (value: { createdAt: string; id: string }) =>
		`${value.createdAt.replace(
			/\.(\d{3,6})Z$/u,
			(_, fraction: string) => `.${fraction.padEnd(6, "0")}Z`
		)}|${value.id}`;
	for (let index = 0; index < entries.length; index++) {
		if (index > 0 && order(entries[index - 1]) <= order(entries[index]))
			invalidStorage();
		if (query.before && order(entries[index]) >= order(query.before))
			invalidStorage();
	}
	const last = entries.at(-1);
	// The repository caps reads at 100. A full final page may lead to an empty next page.
	return {
		entries,
		next_cursor:
			last && entries.length === query.pageSize
				? encodeSharedKeyAdminCursor(id, last)
				: null,
		page_size: query.pageSize,
	};
}

export async function mutateAdminSharedKey(
	repos: GatewayRepositories,
	principal: AdminPrincipal,
	bindings: AdminBindings,
	rawId: string,
	url: string,
	rawBody: string,
	operation: "update" | "delete",
	expectedConsoleSubjectHeader: string | null = null
) {
	const actor = sharedKeyAdminActor(principal, true);
	assertExpectedConsoleSubject(
		principal,
		expectedConsoleSubjectHeader,
		bindings.CINATOKEN_ADMIN_SHARED_KEYS_REQUIRE_REVISION === "true"
	);
	sharedKeyAdminQuery(url, []);
	const id = sharedKeyAdminId(rawId);
	const write = sharedKeyAdminWriteBody(
		rawBody,
		operation,
		bindings.CINATOKEN_ADMIN_SHARED_KEYS_REQUIRE_REVISION === "true"
	);
	const row = await repositoryMethod(repos, "getAdminSharedKeyById")(id);
	if (!row) notFound();
	if (row.id !== id) invalidStorage();
	if (write.rejectedActive) stateConflict();
	if (write.patch.status === "paused" && row.status !== "disabled")
		stateConflict();
	const expected = sharedKeyStateExpectation(row);
	if (
		write.expectedRevision !== undefined &&
		write.expectedRevision !== (await sharedKeyAdminRevision(id, expected))
	)
		stateConflict();
	const audit = {
		auditId: crypto.randomUUID(),
		...actor,
		source: write.source,
		reason: write.reason,
		nowIso: new Date().toISOString(),
	};
	try {
		if (operation === "update") {
			const update = repositoryMethod(repos, "updateSharedKeyAdminWithAudit");
			const outcome = await update({ id, expected, patch: write.patch, audit });
			if (outcome === "conflict") stateConflict();
			if (outcome === "not_found") notFound();
			if (outcome !== "applied" && outcome !== "unchanged") invalidStorage();
			return {
				id,
				outcome,
				auditId: outcome === "applied" ? audit.auditId : null,
			};
		}
		const remove = repositoryMethod(repos, "deleteSharedKeyAdminWithAudit");
		const outcome = await remove({ id, expected, audit });
		if (outcome === "conflict") stateConflict();
		if (outcome === "not_found") notFound();
		if (outcome !== "applied") invalidStorage();
		return { id, deleted: true as const, auditId: audit.auditId };
	} catch (error) {
		if (isSharedKeyEarningHistoryDeleteError(error))
			throw new SharedKeyAdminError(
				409,
				"shared_key_earning_history_immutable",
				"Shared key has credited earnings and cannot be deleted"
			);
		throw error;
	}
}
