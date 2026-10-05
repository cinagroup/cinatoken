import type { NftMintRow, WithdrawalRow } from "@octafuse/core";

export const WITHDRAWAL_STATUSES = [
	"requested",
	"processing",
	"submitted",
	"confirmed",
	"failed",
] as const;
export const NFT_MINT_STATUSES = [
	"pending",
	"processing",
	"submitted",
	"confirmed",
	"failed",
] as const;

export class ChainOperationsError extends Error {
	constructor(
		public readonly status: 400 | 413 | 502,
		public readonly code: string,
		message: string
	) {
		super(message);
	}
}
function invalid(message: string): never {
	throw new ChainOperationsError(
		400,
		"invalid_chain_operations_input",
		message
	);
}
export function chainOperationsQuery(
	url: string,
	allowed: readonly string[]
): URLSearchParams {
	const query = new URL(url).searchParams;
	for (const name of query.keys())
		if (!allowed.includes(name) || query.getAll(name).length !== 1)
			invalid("Unknown or duplicate query parameter");
	return query;
}
export function chainOperationsStatus(
	url: string,
	statuses: readonly string[]
): string | undefined {
	const status = chainOperationsQuery(url, ["status"]).get("status");
	if (status !== null && !statuses.includes(status))
		invalid("Invalid chain job status");
	return status ?? undefined;
}
export function chainOperationsLimit(url: string): number {
	const raw = chainOperationsQuery(url, ["limit"]).get("limit");
	if (raw === null) return 5;
	if (!/^(?:[1-9]|1\d|20)$/u.test(raw))
		invalid("Chain job limit must be an integer from 1 to 20");
	return Number(raw);
}
export function chainOperationsId(value: unknown): string {
	if (
		typeof value !== "string" ||
		!value ||
		value.length > 128 ||
		/[\s/?#%\\\p{Cc}\p{Cf}]/u.test(value) ||
		/^(?:sk-|enc:|sha256:)/u.test(value)
	)
		invalid("Invalid chain job ID");
	try {
		encodeURIComponent(value);
	} catch {
		invalid("Invalid chain job ID");
	}
	return value;
}

/** Duplicate or escaped duplicate JSON members must not silently change the reason. */
export async function chainOperationsRejectReason(
	request: Request
): Promise<string> {
	if (
		!/^application\/json(?:\s*;|$)/iu.test(
			request.headers.get("content-type") ?? ""
		)
	)
		invalid("A JSON rejection reason is required");
	const reader = request.body?.getReader();
	if (!reader) invalid("A rejection reason is required");
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > 4096) {
				await reader.cancel().catch(() => undefined);
				throw new ChainOperationsError(
					413,
					"chain_operations_body_too_large",
					"Rejection body is too large"
				);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	let raw: string;
	let body: unknown;
	try {
		raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		body = JSON.parse(raw);
	} catch {
		invalid("Invalid rejection JSON");
	}
	if (!body || typeof body !== "object" || Array.isArray(body))
		invalid("Rejection body must be an object");
	const tokens = raw.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/gu) ?? [];
	const stack: Array<{
		object: boolean;
		expectingKey: boolean;
		keys: Set<string>;
	}> = [];
	for (const token of tokens) {
		if (token === "{" || token === "[")
			stack.push({
				object: token === "{",
				expectingKey: token === "{",
				keys: new Set(),
			});
		else if (token === "}" || token === "]") stack.pop();
		else {
			const top = stack.at(-1);
			if (!top) continue;
			if (token === ":") top.expectingKey = false;
			else if (token === "," && top.object) top.expectingKey = true;
			else if (token.startsWith('"') && top.object && top.expectingKey) {
				const key: string = JSON.parse(token);
				if (top.keys.has(key)) invalid("Duplicate rejection JSON member");
				top.keys.add(key);
			}
		}
	}
	if (Object.keys(body).length !== 1 || !Object.hasOwn(body, "reason"))
		invalid("Only one rejection reason is accepted");
	const reason = (body as { reason: unknown }).reason;
	if (
		typeof reason !== "string" ||
		!reason.trim() ||
		Array.from(reason.trim()).length > 500 ||
		/[\p{Cc}\p{Cf}]/u.test(reason)
	)
		invalid(
			"Rejection reason must contain 1 to 500 characters without controls"
		);
	return reason.trim();
}

function storageInvalid(): never {
	throw new ChainOperationsError(
		502,
		"chain_operations_storage_unavailable",
		"Chain job storage returned invalid data"
	);
}
function text(value: unknown, max: number, nullable = false): string | null {
	if (nullable && value === null) return null;
	if (
		typeof value !== "string" ||
		!value ||
		value.length > max ||
		/[\p{Cc}\p{Cf}]/u.test(value)
	)
		storageInvalid();
	return value;
}
function amount(value: unknown, nullable = false): number | null {
	if (nullable && value === null) return null;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
		storageInvalid();
	return value;
}
function chainId(value: unknown): number | null {
	if (value === null) return null;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
		storageInvalid();
	return value;
}
function timestamp(value: unknown, nullable = false): string | null {
	const raw = text(value, 64, nullable);
	if (raw !== null && !Number.isFinite(Date.parse(raw))) storageInvalid();
	return raw;
}
function storedId(value: unknown): string {
	try {
		return chainOperationsId(value);
	} catch {
		storageInvalid();
	}
}

/** Whitelist projection excludes signer material, RPC configuration and raw transactions. */
export function projectAdminWithdrawal(row: WithdrawalRow): WithdrawalRow {
	if (
		!row ||
		typeof row !== "object" ||
		!WITHDRAWAL_STATUSES.includes(
			row.status as (typeof WITHDRAWAL_STATUSES)[number]
		)
	)
		storageInvalid();
	if (typeof row.currency !== "string" || !/^[A-Z]{3}$/u.test(row.currency))
		storageInvalid();
	return {
		id: storedId(row.id),
		userId: text(row.userId, 600)!,
		amount: amount(row.amount)!,
		fee: amount(row.fee)!,
		netAmount: amount(row.netAmount)!,
		currency: row.currency,
		walletAddress: text(row.walletAddress, 256)!,
		status: row.status,
		tokenAmount: amount(row.tokenAmount, true),
		txHash: text(row.txHash, 256, true),
		chainId: chainId(row.chainId),
		failureReason: text(row.failureReason, 10000, true),
		createdAt: timestamp(row.createdAt)!,
		updatedAt: timestamp(row.updatedAt)!,
		confirmedAt: timestamp(row.confirmedAt, true),
	};
}
export function projectAdminNftMint(row: NftMintRow): NftMintRow {
	if (
		!row ||
		typeof row !== "object" ||
		!NFT_MINT_STATUSES.includes(
			row.status as (typeof NFT_MINT_STATUSES)[number]
		)
	)
		storageInvalid();
	if (!Number.isSafeInteger(row.badgeTokenId) || row.badgeTokenId < 0)
		storageInvalid();
	return {
		id: storedId(row.id),
		userId: text(row.userId, 600)!,
		badgeTokenId: row.badgeTokenId,
		tierName: text(row.tierName, 256)!,
		walletAddress: text(row.walletAddress, 256)!,
		status: row.status,
		txHash: text(row.txHash, 256, true),
		chainId: chainId(row.chainId),
		valueSnapshot: amount(row.valueSnapshot)!,
		failureReason: text(row.failureReason, 10000, true),
		createdAt: timestamp(row.createdAt)!,
		confirmedAt: timestamp(row.confirmedAt, true),
	};
}
export function projectAdminChainRows<T extends { id: string; status: string }>(
	rows: T[],
	project: (row: T) => T,
	status?: string
): T[] {
	if (!Array.isArray(rows)) storageInvalid();
	const result = rows.map(project);
	if (
		new Set(result.map((row) => row.id)).size !== result.length ||
		(status !== undefined && result.some((row) => row.status !== status))
	)
		storageInvalid();
	return result;
}
export function chainOperationsMetadata(
	kind: "withdrawal" | "nft_mint",
	queueConfigured: boolean
) {
	return {
		scope: "global_portal_ledger" as const,
		withdrawalCurrencySource: "stored_row" as const,
		// Shared-key earnings are USD; user NFT mint snapshots that contribution ledger.
		nftValueSnapshotCurrency: "USD" as const,
		nftValueSnapshotCurrencySource: "seller_contribution_ledger" as const,
		amountUnit: "major" as const,
		queueConfigured,
		processEligibleStatuses:
			kind === "withdrawal" ? ["requested", "submitted"] : ["pending"],
		...(kind === "withdrawal"
			? { rejectEligibleStatus: "requested" as const }
			: {}),
	};
}
