import postgres from "postgres";
import type { GatewayRepositories, SharedKeyRow } from "@octafuse/core";
import type { UserBindings } from "./user-env";
import { projectCurrentSellerCreditedUsageWithReader } from "./shared-key-credited-usage-reader";

const STATS_COOKIE = "__Host-cinatoken_stats_session";
const ISSUER_URL = "https://cinatoken-stats-issuer.internal/v1/claim";
const READER_LOGIN = "cinatoken_gateway_stats_reader";
const ID = /^[A-Za-z0-9:_-]{1,128}$/u;
const KEY_ID = /^[A-Za-z0-9:_-]{1,64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const HEX_32 = /^[0-9a-f]{64}$/u;

type CreditedUsageRow = {
	shared_key_id: string;
	seller_user_id: string;
	input_tokens: string | number;
	output_tokens: string | number;
	net_micros: string | number;
	last_credited_at: string | Date | null;
};

export type SignedStatsClaim = {
	keyId: string;
	sellerUserId: string;
	keyIds: string[];
	expiresEpoch: number;
	nonce: string;
	signatureHex: string;
};

function statsCookie(request: Request): string {
	const matches = (request.headers.get("cookie") ?? "")
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part.startsWith(`${STATS_COOKIE}=`));
	if (matches.length !== 1)
		throw new Error("shared_key_stats_independent_session_required");
	const value = matches[0].slice(STATS_COOKIE.length + 1);
	if (!/^[A-Za-z0-9_-]{32,256}$/u.test(value)) {
		throw new Error("shared_key_stats_independent_session_invalid");
	}
	return `${STATS_COOKIE}=${value}`;
}

function canonicalIds(ids: readonly string[]): string[] {
	if (ids.length < 1 || ids.length > 200 || ids.some((id) => !ID.test(id))) {
		throw new Error("shared_key_stats_claim_scope_invalid");
	}
	const sorted = [...ids].sort();
	if (new Set(sorted).size !== sorted.length) {
		throw new Error("shared_key_stats_claim_scope_duplicate");
	}
	return sorted;
}

/** The issuer receives only its own opaque cookie and requested IDs. It must
 * independently authenticate that cookie and derive the seller identity. */
export async function requestSignedSellerStatsClaim(
	issuer: Pick<Fetcher, "fetch">,
	request: Request,
	expectedSellerUserId: string,
	requestedIds: readonly string[]
): Promise<SignedStatsClaim> {
	const keyIds = canonicalIds(requestedIds);
	const response = await issuer.fetch(
		new Request(ISSUER_URL, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"cache-control": "no-store",
				cookie: statsCookie(request),
			},
			body: JSON.stringify({ keyIds }),
		})
	);
	if (!response.ok) throw new Error("shared_key_stats_claim_issuer_rejected");
	const body = (await response.json().catch(() => null)) as Record<
		string,
		unknown
	> | null;
	if (!body || typeof body !== "object")
		throw new Error("shared_key_stats_claim_issuer_invalid");
	const expiresEpoch = body.expiresEpoch;
	const now = Math.floor(Date.now() / 1000);
	if (
		typeof body.keyId !== "string" ||
		!KEY_ID.test(body.keyId) ||
		typeof body.sellerUserId !== "string" ||
		body.sellerUserId !== expectedSellerUserId ||
		!Array.isArray(body.keyIds) ||
		body.keyIds.length !== keyIds.length ||
		body.keyIds.some((id, index) => id !== keyIds[index]) ||
		typeof expiresEpoch !== "number" ||
		!Number.isSafeInteger(expiresEpoch) ||
		expiresEpoch <= now ||
		expiresEpoch > now + 300 ||
		typeof body.nonce !== "string" ||
		!UUID.test(body.nonce) ||
		typeof body.signatureHex !== "string" ||
		!HEX_32.test(body.signatureHex)
	) {
		throw new Error("shared_key_stats_claim_issuer_scope_mismatch");
	}
	return body as SignedStatsClaim;
}

/** Dedicated direct LOGIN connection. The SQL endpoint independently checks
 * SESSION_USER, HMAC, scope, readiness, ownership, and nonce. */
export async function readSignedSellerStatsPage(
	connectionString: string,
	claim: SignedStatsClaim
): Promise<CreditedUsageRow[]> {
	const sql = postgres(connectionString, {
		max: 1,
		prepare: false,
		fetch_types: false,
	});
	try {
		const login = await sql.unsafe<{ session_user: string }[]>(
			"SELECT SESSION_USER::text AS session_user"
		);
		if (login[0]?.session_user !== READER_LOGIN) {
			throw new Error("shared_key_stats_reader_login_mismatch");
		}
		return await sql.unsafe<CreditedUsageRow[]>(
			`SELECT * FROM cinatoken_shared_stats.read_shared_key_credited_usage_with_claim(
				$1::text,$2::text,pg_catalog.string_to_array($3::text,','),
				$4::bigint,$5::uuid,pg_catalog.decode($6::text,'hex'))`,
			[
				claim.keyId,
				claim.sellerUserId,
				claim.keyIds.join(","),
				claim.expiresEpoch,
				claim.nonce,
				claim.signatureHex,
			]
		);
	} finally {
		await sql.end();
	}
}

/** Default-off seller route binding. The ordinary GatewayRepositories client
 * is used only for key listing; it never runs the private credited-usage SQL. */
export async function projectSellerCreditedUsageWithSignedClaims(
	repositories: GatewayRepositories,
	keys: SharedKeyRow[],
	sellerUserId: string,
	request: Request,
	bindings: UserBindings
): Promise<SharedKeyRow[]> {
	if (repositories.client.driver !== "postgres") {
		throw new Error("shared_key_stats_reader_requires_postgres");
	}
	const issuer = bindings.STATS_CLAIM_ISSUER;
	const reader = bindings.STATS_READER_HYPERDRIVE;
	const connectionString = reader?.connectionString?.trim();
	if (!issuer || !connectionString || typeof issuer.fetch !== "function") {
		throw new Error("shared_key_stats_independent_bindings_required");
	}
	const runtimeConnectionString =
		bindings.HYPERDRIVE?.connectionString?.trim() ??
		bindings.DATABASE_URL?.trim();
	if (runtimeConnectionString && runtimeConnectionString === connectionString) {
		throw new Error("shared_key_stats_reader_binding_reuses_runtime");
	}
	// Check even an empty list: enabling the route must require an independent
	// stats session, not silently report success from a mutable portal session.
	statsCookie(request);
	return projectCurrentSellerCreditedUsageWithReader(
		keys,
		sellerUserId,
		async (seller, ids) => {
			const claim = await requestSignedSellerStatsClaim(
				issuer,
				request,
				seller,
				ids
			);
			return readSignedSellerStatsPage(connectionString, claim);
		}
	);
}
