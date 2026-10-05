import assert from "node:assert/strict";
import test from "node:test";
import type {
	GatewayRepositories,
	NftMintRow,
	WithdrawalRow,
} from "@octafuse/core";
import type { AdminBindings } from "@/lib/admin-env";
import type { AdminPermission, AdminPrincipal } from "@/lib/admin-principal";
import { createAdminApp } from "@/lib/admin-app";
import { protectAdminConfigResponse } from "@/lib/admin-config-cache";
import { EXPECTED_CONSOLE_SUBJECT_HEADER } from "./expected-console-subject";

const time = "2026-10-01T00:00:00.123456Z";
const hidden = "synthetic-hidden-signer-material";
const withdrawal = (extra: Partial<WithdrawalRow> = {}): WithdrawalRow => ({
	id: "withdrawal-1",
	userId: "seller-1",
	amount: 10.125001,
	fee: 0.125001,
	netAmount: 10,
	currency: "CNY",
	walletAddress: "0x" + "a".repeat(40),
	status: "requested",
	tokenAmount: null,
	txHash: null,
	chainId: null,
	failureReason: null,
	createdAt: time,
	updatedAt: time,
	confirmedAt: null,
	...extra,
});
const mint = (extra: Partial<NftMintRow> = {}): NftMintRow => ({
	id: "mint-1",
	userId: "seller-1",
	badgeTokenId: 105,
	tierName: "Bronze",
	walletAddress: "0x" + "a".repeat(40),
	status: "pending",
	txHash: null,
	chainId: null,
	valueSnapshot: 10.125001,
	failureReason: null,
	createdAt: time,
	confirmedAt: null,
	...extra,
});
function named(permissions: AdminPermission[]): AdminPrincipal {
	return {
		type: "api_key",
		id: "admin_key:synthetic",
		keyId: "synthetic",
		permissions,
	};
}
function consolePrincipal(subject = "operator%one"): AdminPrincipal {
	const username = `cinaauth:${subject}`;
	return { type: "console", id: `console:${username}`, username };
}
type Options = {
	principal?: AdminPrincipal | null;
	withdrawals?: WithdrawalRow[];
	mints?: NftMintRow[];
	queue?: boolean;
	queueError?: Error;
	readError?: Error;
	rejectResult?:
		| { kind: "rejected"; withdrawalId: string }
		| { kind: "conflict" | "not-found" };
	rejectError?: Error;
};
function fixture(options: Options = {}) {
	const calls = {
		reads: [] as Array<{ kind: string; status?: string }>,
		batches: [] as unknown[][],
		rejects: [] as unknown[][],
	};
	const rows = options.withdrawals ?? [withdrawal()];
	const mints = options.mints ?? [mint()];
	const repositories = {
		client: { driver: "d1", raw: {} },
		portalLedger: {
			listAllWithdrawals: async (status?: string) => {
				calls.reads.push({ kind: "withdrawal", status });
				if (options.readError) throw options.readError;
				return rows.filter(
					(row) => status === undefined || row.status === status
				);
			},
			listAllNftMints: async (status?: string) => {
				calls.reads.push({ kind: "nft_mint", status });
				if (options.readError) throw options.readError;
				return mints.filter(
					(row) => status === undefined || row.status === status
				);
			},
			rejectRequestedWithdrawal: async (...args: unknown[]) => {
				calls.rejects.push(args);
				if (options.rejectError) throw options.rejectError;
				return (
					options.rejectResult ?? { kind: "rejected", withdrawalId: args[0] }
				);
			},
			getWithdrawal: () =>
				assert.fail("Admin rejection must not pre-read and guess ledger state"),
			refundWithdrawal: () =>
				assert.fail(
					"Admin rejection must not use the wider chain-revert refund method"
				),
		},
		systemConfig: {
			getConfig: () =>
				assert.fail(
					"Gateway billing currency is not a portal ledger authority"
				),
		},
		providers: {
			getProviderRowById: () =>
				assert.fail("Chain admin must not reveal Provider credentials"),
		},
	} as unknown as GatewayRepositories;
	const bindings = {
		STORAGE_CONTEXT: { repositories },
		ADMIN_PRINCIPAL:
			options.principal === undefined
				? named(["users.write"])
				: options.principal ?? undefined,
		...(options.queue === false
			? {}
			: {
					CHAIN_JOBS: {
						sendBatch: async (batch: unknown[]) => {
							calls.batches.push(batch);
							if (options.queueError) throw options.queueError;
						},
					},
			  }),
	} as unknown as AdminBindings;
	const app = createAdminApp();
	return {
		calls,
		rows,
		mints,
		request: (path: string, init: RequestInit = {}) =>
			app.request(path, init, bindings),
	};
}
async function body(response: Response) {
	return (await response.json()) as Record<string, unknown>;
}
function privateResponse(response: Response, status: number) {
	assert.equal(response.status, status);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
}
const rejectInit = (
	reason: unknown = "Reviewed before chain claim",
	headers: HeadersInit = {}
): RequestInit => ({
	method: "POST",
	headers: { "content-type": "application/json", ...headers },
	body: JSON.stringify({ reason }),
});

test("chain lists keep legacy arrays/total and project all ledger fields without extra secrets or configuration reads", async () => {
	const f = fixture({
		withdrawals: [
			{
				...withdrawal(),
				rawTransaction: hidden,
				signerPrivateKey: hidden,
			} as WithdrawalRow,
		],
		mints: [
			{ ...mint(), rpcUrl: hidden, rawTransaction: hidden } as NftMintRow,
		],
	});
	for (const [path, expected, source] of [
		["withdrawals", withdrawal(), ["requested", "submitted"]],
		["nft-mints", mint(), ["pending"]],
	] as const) {
		const response = await f.request(`/admin/${path}`);
		privateResponse(response, 200);
		const data = await body(response);
		assert.equal(data.success, true);
		assert.equal(data.total, 1);
		assert.deepEqual(data.data, [expected]);
		assert.equal(JSON.stringify(data).includes(hidden), false);
		assert.deepEqual(data.meta, {
			scope: "global_portal_ledger",
			withdrawalCurrencySource: "stored_row",
			nftValueSnapshotCurrency: "USD",
			nftValueSnapshotCurrencySource: "seller_contribution_ledger",
			amountUnit: "major",
			queueConfigured: true,
			processEligibleStatuses: source,
			...(path === "withdrawals" ? { rejectEligibleStatus: "requested" } : {}),
		});
	}
});

test("all five actual states filter independently, including NFT processing, and HEAD is private and bodyless", async () => {
	for (const kind of ["withdrawals", "nft-mints"]) {
		const statuses = [
			kind === "withdrawals" ? "requested" : "pending",
			"processing",
			"submitted",
			"confirmed",
			"failed",
		];
		const f = fixture({
			withdrawals: statuses.map((status, i) =>
				withdrawal({ id: `withdrawal-${i}`, status })
			),
			mints: statuses.map((status, i) => mint({ id: `mint-${i}`, status })),
		});
		for (const status of statuses) {
			const response = await f.request(`/admin/${kind}?status=${status}`);
			privateResponse(response, 200);
			const data = await body(response);
			assert.equal(data.total, 1);
			assert.equal((data.data as Array<{ status: string }>)[0].status, status);
		}
		const head = await f.request(`/admin/${kind}`, { method: "HEAD" });
		privateResponse(head, 200);
		assert.equal(await head.text(), "");
	}
});

test("read/write permission and authentication failures are private before domain reads or queue writes", async () => {
	for (const path of ["withdrawals", "nft-mints"]) {
		const none = fixture({ principal: named(["models.read"]) });
		privateResponse(await none.request(`/admin/${path}`), 403);
		privateResponse(
			await none.request(`/admin/${path}/process`, { method: "POST" }),
			403
		);
		assert.deepEqual(none.calls, { reads: [], batches: [], rejects: [] });
		const read = fixture({ principal: named(["users.read"]) });
		privateResponse(await read.request(`/admin/${path}`), 200);
		privateResponse(
			await read.request(`/admin/${path}/process`, { method: "POST" }),
			403
		);
		assert.equal(read.calls.batches.length, 0);
		const unauthenticated = fixture({ principal: null });
		privateResponse(await unauthenticated.request(`/admin/${path}`), 401);
		privateResponse(
			await unauthenticated.request(`/admin/${path}/process`, {
				method: "POST",
			}),
			401
		);
		assert.deepEqual(unauthenticated.calls, {
			reads: [],
			batches: [],
			rejects: [],
		});
	}
	const read = fixture({ principal: named(["users.read"]) });
	privateResponse(
		await read.request("/admin/withdrawals/withdrawal-1/reject", rejectInit()),
		403
	);
	assert.deepEqual(read.calls, { reads: [], batches: [], rejects: [] });
});

test("provided Console write preconditions bind the canonical current subject; legacy Console/Bearer stay compatible", async () => {
	for (const path of [
		"/admin/withdrawals/process",
		"/admin/nft-mints/process",
		"/admin/withdrawals/withdrawal-1/reject",
	]) {
		const init = path.endsWith("/reject") ? rejectInit() : { method: "POST" };
		for (const [header, status] of [
			["other-subject", 403],
			["operator%one", 400],
			["%256fperator", 403],
		] as const) {
			const f = fixture({ principal: consolePrincipal() });
			const headers = new Headers(init.headers);
			if (header !== undefined)
				headers.set(EXPECTED_CONSOLE_SUBJECT_HEADER, header);
			const response = await f.request(path, { ...init, headers });
			privateResponse(response, status);
			assert.deepEqual(f.calls, { reads: [], batches: [], rejects: [] });
		}
		const f = fixture({ principal: consolePrincipal() });
		const headers = new Headers(init.headers);
		headers.set(
			EXPECTED_CONSOLE_SUBJECT_HEADER,
			encodeURIComponent("operator%one")
		);
		privateResponse(await f.request(path, { ...init, headers }), 200);
		const bearer = fixture();
		privateResponse(await bearer.request(path, init), 200);
		const legacyConsole = fixture({ principal: consolePrincipal() });
		privateResponse(await legacyConsole.request(path, init), 200);
		const rejectedBearer = fixture();
		privateResponse(
			await rejectedBearer.request(path, { ...init, headers }),
			400
		);
		assert.deepEqual(rejectedBearer.calls, {
			reads: [],
			batches: [],
			rejects: [],
		});
	}
});

test("strict list/query validation never widens an invalid filter into an unfiltered list", async () => {
	for (const kind of ["withdrawals", "nft-mints"]) {
		for (const query of [
			"?status=",
			"?status=unknown",
			"?status=pending&status=confirmed",
			"?limit=5",
			"?owner=other",
		]) {
			const f = fixture();
			privateResponse(await f.request(`/admin/${kind}${query}`), 400);
			assert.deepEqual(f.calls, { reads: [], batches: [], rejects: [] });
		}
		for (const query of [
			"?limit=0",
			"?limit=21",
			"?limit=05",
			"?limit=1.5",
			"?limit=Infinity",
			"?limit=1e1",
			"?limit=5&limit=5",
			"?status=requested",
		]) {
			const f = fixture();
			privateResponse(
				await f.request(`/admin/${kind}/process${query}`, { method: "POST" }),
				400
			);
			assert.deepEqual(f.calls, { reads: [], batches: [], rejects: [] });
		}
		const f = fixture();
		privateResponse(
			await f.request(`/admin/${kind}/process`, {
				method: "POST",
				body: '{"confirm":true}',
			}),
			400
		);
		assert.deepEqual(f.calls, { reads: [], batches: [], rejects: [] });
	}
});

test("an optional list subject precondition is always verified when supplied, while legacy reads remain compatible", async () => {
	for (const kind of ["withdrawals", "nft-mints"]) {
		const stale = fixture({ principal: consolePrincipal() });
		privateResponse(
			await stale.request(`/admin/${kind}`, {
				headers: { [EXPECTED_CONSOLE_SUBJECT_HEADER]: "other" },
			}),
			403
		);
		assert.deepEqual(stale.calls, { reads: [], batches: [], rejects: [] });
		const matched = fixture({ principal: consolePrincipal() });
		privateResponse(
			await matched.request(`/admin/${kind}`, {
				headers: {
					[EXPECTED_CONSOLE_SUBJECT_HEADER]: encodeURIComponent("operator%one"),
				},
			}),
			200
		);
		const namedKey = fixture();
		privateResponse(
			await namedKey.request(`/admin/${kind}`, {
				headers: { [EXPECTED_CONSOLE_SUBJECT_HEADER]: "operator" },
			}),
			400
		);
		assert.deepEqual(namedKey.calls, { reads: [], batches: [], rejects: [] });
	}
});

test("process reports queued only, respects the default and maximum, and does not mutate chain or financial state", async () => {
	for (const [query, count] of [
		["", 5],
		["?limit=1", 1],
		["?limit=20", 20],
	] as const) {
		const f = fixture({
			withdrawals: [
				withdrawal({ id: "excluded-processing", status: "processing" }),
				...Array.from({ length: 25 }, (_, i) =>
					withdrawal({
						id: `withdrawal-${i}`,
						status: i % 2 ? "submitted" : "requested",
					})
				),
			],
			mints: [
				mint({ id: "excluded-processing", status: "processing" }),
				...Array.from({ length: 25 }, (_, i) => mint({ id: `mint-${i}` })),
			],
		});
		for (const kind of ["withdrawals", "nft-mints"]) {
			const before = JSON.stringify([f.rows, f.mints]);
			const response = await f.request(`/admin/${kind}/process${query}`, {
				method: "POST",
			});
			privateResponse(response, 200);
			assert.deepEqual(await body(response), {
				success: true,
				data: { queued: count },
				meta: { result: "queued", chainConfirmation: false },
			});
			const batch = f.calls.batches.at(-1)! as Array<{
				body: { kind: string; id: string };
			}>;
			assert.equal(batch.length, count);
			assert.deepEqual(batch[0], {
				body: {
					kind: kind === "withdrawals" ? "withdrawal" : "nft_mint",
					id: kind === "withdrawals" ? "withdrawal-0" : "mint-0",
				},
			});
			assert.equal(
				batch.some((item) => item.body.id === "excluded-processing"),
				false
			);
			assert.equal(JSON.stringify([f.rows, f.mints]), before);
			assert.equal(f.calls.rejects.length, 0);
		}
	}
});

test("unconfigured and empty queues are distinct; empty eligible results never sendBatch([])", async () => {
	for (const kind of ["withdrawals", "nft-mints"]) {
		const unavailable = fixture({ queue: false });
		const response = await unavailable.request(`/admin/${kind}/process`, {
			method: "POST",
		});
		privateResponse(response, 503);
		assert.equal((await body(response)).code, "chain_queue_unavailable");
		assert.deepEqual(unavailable.calls, {
			reads: [],
			batches: [],
			rejects: [],
		});
		const empty = fixture({
			withdrawals: [withdrawal({ status: "processing" })],
			mints: [mint({ status: "submitted" })],
		});
		privateResponse(
			await empty.request(`/admin/${kind}/process`, { method: "POST" }),
			200
		);
		assert.equal(empty.calls.batches.length, 0);
		const list = await empty.request(`/admin/${kind}`);
		assert.equal(
			((await body(list)).meta as { queueConfigured: boolean }).queueConfigured,
			true
		);
	}
});

test("queue failures do not retry or claim confirmation; one deliberate repeat remains a separate queue acknowledgement", async () => {
	for (const kind of ["withdrawals", "nft-mints"]) {
		const f = fixture({ queueError: new Error("synthetic queue unavailable") });
		const response = await f.request(`/admin/${kind}/process`, {
			method: "POST",
		});
		privateResponse(response, 500);
		assert.equal((await body(response)).success, false);
		assert.equal(f.calls.batches.length, 1);
		assert.equal(f.calls.rejects.length, 0);
		const repeat = fixture();
		for (let i = 0; i < 2; i++)
			privateResponse(
				await repeat.request(`/admin/${kind}/process`, { method: "POST" }),
				200
			);
		assert.equal(repeat.calls.batches.length, 2);
		assert.deepEqual(repeat.calls.batches[0], repeat.calls.batches[1]);
	}
});

test("atomic rejection returns only its exact confirmed result and maps conflicts/missing rows without a financial pre-read", async () => {
	for (const [result, status, code] of [
		[{ kind: "conflict" }, 409, "withdrawal_rejection_conflict"],
		[{ kind: "not-found" }, 404, "withdrawal_not_found"],
	] as const) {
		const f = fixture({ rejectResult: result });
		const response = await f.request(
			"/admin/withdrawals/withdrawal-1/reject",
			rejectInit()
		);
		privateResponse(response, status);
		assert.equal((await body(response)).code, code);
		assert.equal(f.calls.rejects.length, 1);
		assert.equal(f.calls.reads.length, 0);
	}
	const f = fixture();
	const response = await f.request(
		"/admin/withdrawals/withdrawal-1/reject",
		rejectInit("  Reviewed before chain claim  ")
	);
	privateResponse(response, 200);
	assert.deepEqual((await body(response)).data, {
		withdrawalId: "withdrawal-1",
		status: "failed",
		result: "rejected_and_refunded",
	});
	assert.deepEqual(f.calls.rejects[0].slice(0, 2), [
		"withdrawal-1",
		"Reviewed before chain claim",
	]);
	assert.ok(Number.isFinite(Date.parse(f.calls.rejects[0][2] as string)));
	assert.equal(f.calls.batches.length, 0);
	assert.equal(f.calls.reads.length, 0);
});

test("rejection rejects malformed IDs, queries and reasons before atomic storage", async () => {
	for (const [path, init] of [
		["/admin/withdrawals/sk-invalid-id/reject", rejectInit()],
		["/admin/withdrawals/withdrawal%252Fother/reject", rejectInit()],
		["/admin/withdrawals/withdrawal-1/reject?limit=5", rejectInit()],
		...["", " ", "x".repeat(501), "reason\ncontrol", null, 5].map((reason) => [
			"/admin/withdrawals/withdrawal-1/reject",
			rejectInit(reason),
		]),
		...[
			"{",
			"{}",
			"[]",
			'{"reason":"a","extra":true}',
			'{"reason":"a","reason":"b"}',
			'{"reason":"a","\\u0072eason":"b"}',
		].map((raw) => [
			"/admin/withdrawals/withdrawal-1/reject",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: raw,
			},
		]),
		[
			"/admin/withdrawals/withdrawal-1/reject",
			{ method: "POST", body: JSON.stringify({ reason: "valid" }) },
		],
	] as Array<[string, RequestInit]>) {
		const f = fixture();
		privateResponse(await f.request(path, init), 400);
		assert.deepEqual(f.calls, { reads: [], batches: [], rejects: [] });
	}
	const valid = fixture();
	privateResponse(
		await valid.request(
			"/admin/withdrawals/withdrawal-1/reject",
			rejectInit('Reason includes a quoted "field": explanation')
		),
		200
	);
	const unicode = fixture();
	privateResponse(
		await unicode.request(
			"/admin/withdrawals/withdrawal-1/reject",
			rejectInit("😀".repeat(500))
		),
		200
	);
	assert.equal(Array.from(unicode.calls.rejects[0][1] as string).length, 500);
});

test("unknown rejection outcome, malformed acknowledgement and storage failures are private and never retried", async () => {
	for (const options of [
		{ rejectError: new Error("synthetic commit acknowledgement unavailable") },
		{
			rejectResult: {
				kind: "rejected" as const,
				withdrawalId: "other-withdrawal",
			},
		},
	]) {
		const f = fixture(options);
		const response = await f.request(
			"/admin/withdrawals/withdrawal-1/reject",
			rejectInit()
		);
		privateResponse(response, 500);
		assert.equal((await body(response)).success, false);
		assert.equal(f.calls.rejects.length, 1);
		assert.equal(f.calls.reads.length, 0);
	}
	for (const kind of ["withdrawals", "nft-mints"]) {
		const f = fixture({
			readError: new Error("synthetic storage unavailable"),
		});
		privateResponse(await f.request(`/admin/${kind}`), 500);
		assert.equal(f.calls.reads.length, 1);
	}
});

test("bounded rejection parsing rejects actual streamed overflow and invalid UTF-8 without storage calls", async () => {
	const overflow = fixture();
	privateResponse(
		await overflow.request("/admin/withdrawals/withdrawal-1/reject", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ reason: "x".repeat(5000) }),
		}),
		413
	);
	assert.deepEqual(overflow.calls, { reads: [], batches: [], rejects: [] });
	const invalid = fixture();
	privateResponse(
		await invalid.request("/admin/withdrawals/withdrawal-1/reject", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: new Uint8Array([0x7b, 0xff, 0x7d]),
		}),
		400
	);
	assert.deepEqual(invalid.calls, { reads: [], batches: [], rejects: [] });
});

test("unsupported mutations do not fall through to a process or rejection and remain private", async () => {
	for (const kind of ["withdrawals", "nft-mints"]) {
		for (const method of ["PUT", "PATCH", "DELETE"]) {
			const f = fixture();
			privateResponse(
				await f.request(`/admin/${kind}/process`, { method }),
				404
			);
			assert.deepEqual(f.calls, { reads: [], batches: [], rejects: [] });
		}
	}
	const f = fixture();
	privateResponse(
		await f.request("/admin/nft-mints/mint-1/reject", rejectInit()),
		404
	);
	assert.deepEqual(f.calls, { reads: [], batches: [], rejects: [] });
});

test("malformed or duplicate stored rows fail the whole projection, retaining nulls and exact valid amounts", async () => {
	for (const row of [
		withdrawal({ amount: NaN }),
		withdrawal({ chainId: -1 }),
		withdrawal({ currency: "unknown" }),
		withdrawal({ status: "unknown" }),
	]) {
		const f = fixture({ withdrawals: [row] });
		privateResponse(await f.request("/admin/withdrawals"), 502);
		assert.equal(f.calls.batches.length, 0);
	}
	const duplicates = fixture({ withdrawals: [withdrawal(), withdrawal()] });
	privateResponse(
		await duplicates.request("/admin/withdrawals/process", { method: "POST" }),
		502
	);
	assert.equal(duplicates.calls.batches.length, 0);
	const invalidMint = fixture({ mints: [mint({ valueSnapshot: Infinity })] });
	privateResponse(await invalidMint.request("/admin/nft-mints"), 502);
});

test("outer body limits and BFF early authentication/origin/runtime failures keep both domains private", async () => {
	for (const kind of ["withdrawals", "nft-mints"]) {
		const f = fixture();
		privateResponse(
			await f.request(`/admin/${kind}/process`, {
				method: "POST",
				headers: { "content-length": String(3 * 1024 * 1024) },
				body: "x",
			}),
			413
		);
		assert.deepEqual(f.calls, { reads: [], batches: [], rejects: [] });
		for (const status of [401, 403, 413, 503]) {
			for (const path of [
				`/api/admin/${kind}`,
				`/api/admin/${kind}/process`,
				`/api/admin/${kind}/`,
				`/api/admin/${kind.replace("-", "%2D")}/process`,
			]) {
				const response = protectAdminConfigResponse(
					new Request(`https://console.example.test${path}`),
					new Response("synthetic early failure", { status })
				);
				privateResponse(response, status);
			}
		}
	}
});
