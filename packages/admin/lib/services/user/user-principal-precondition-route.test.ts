import assert from "node:assert/strict";
import test from "node:test";
import type {
	GatewayRepositories,
	InsertNftMintParams,
	NftMintRow,
} from "@octafuse/core";
import { Hono } from "hono";
import { hashSessionToken } from "@/lib/auth";
import { userNftRoutes } from "@/lib/routes/user/nft";
import { createUserApp } from "@/lib/user-app";
import { authenticateUserRequest } from "@/lib/user-auth";
import type { UserEnv } from "@/lib/user-env";
import {
	USER_PRINCIPAL_PRECONDITION_HEADER,
	userPrincipalPrecondition,
} from "@/lib/user-principal-precondition";
import { userWorkspacePrecondition } from "@/lib/user-workspace-precondition";
import {
	CinaTokenApiError,
	createCinaTokenApi,
} from "../../../../web/src/cinatoken/api";

type AuthenticationRepositories = Parameters<typeof authenticateUserRequest>[1];
type CookieIdentity = "a" | "b" | null;

/** Actual authentication/middleware/NFT code; sessions, workspace projection and repositories are controlled fixtures. */
async function fixture(userAId = "fixture-user-a") {
	const users = {
		a: {
			id: userAId,
			subject: "fixture-sub-a",
			email: "a@example.test",
			status: "active",
		},
		b: {
			id: "fixture-user-b",
			subject: "fixture-sub-b",
			email: "b@example.test",
			status: "active",
		},
	};
	const tokens = {
		a: "synthetic-principal-a-session-only",
		b: "synthetic-principal-b-session-only",
	};
	const hashes = {
		a: await hashSessionToken(tokens.a),
		b: await hashSessionToken(tokens.b),
	};
	const sessions = new Map([
		[hashes.a, users.a.subject],
		[hashes.b, users.b.subject],
	]);
	const authReads: string[] = [];
	const ledgerReads: string[] = [];
	const workspaceResolutions: string[] = [];
	const configReads: string[] = [];
	const rows: NftMintRow[] = [];
	const queue: unknown[] = [];
	const deletedSessions: { repository: string; tokenHash: string }[] = [];
	const authenticationRepositories: AuthenticationRepositories = {
		portalAccess: {
			getValidSession: async (tokenHash) => {
				authReads.push("session");
				const subject = sessions.get(tokenHash);
				return subject
					? ({ subject } as Awaited<
							ReturnType<
								AuthenticationRepositories["portalAccess"]["getValidSession"]
							>
					  >)
					: null;
			},
		},
		users: {
			getByExternalPair: async (namespace, subject) => {
				assert.equal(namespace, "cinaauth");
				authReads.push(subject);
				return Object.values(users).find(
					(user) => user.subject === subject
				) as unknown as Awaited<
					ReturnType<AuthenticationRepositories["users"]["getByExternalPair"]>
				>;
			},
			createUser: async () => {
				throw new Error("The fixture must not provision a user");
			},
		},
	};
	const repositories = {
		client: {
			driver: "d1",
			drizzle: {
				select: () => ({
					from: () => ({ where: () => ({ limit: async () => [] }) }),
				}),
			},
		},
		systemConfig: {
			getConfig: async () => {
				configReads.push("config");
				return null;
			},
		},
		portalAccess: {
			deleteSession: async (tokenHash: string) => {
				deletedSessions.push({ repository: "portal", tokenHash });
				sessions.delete(tokenHash);
			},
		},
		adminAccess: {
			deleteSession: async (tokenHash: string) => {
				deletedSessions.push({ repository: "admin", tokenHash });
			},
		},
		portalLedger: {
			ensureUserEarnings: async (userId: string) => {
				ledgerReads.push(userId);
			},
			getUserEarnings: async (userId: string) => {
				ledgerReads.push(userId);
				return {
					userId,
					balance: 25.123456,
					lockedAmount: 0,
					lifetimeEarned: 25.123456,
					lifetimeWithdrawn: 0,
					contributionValue: 25.123456,
					walletAddress: `0x${"1".repeat(40)}`,
					walletVerifiedAt: null,
					highestBadgeTier: 0,
					updatedAt: "2026-10-04T00:00:00Z",
				};
			},
			getNftMintsByUser: async (userId: string) => {
				ledgerReads.push(userId);
				return rows.filter((row) => row.userId === userId);
			},
			insertNftMint: async (input: InsertNftMintParams) => {
				if (
					rows.some(
						(row) =>
							row.userId === input.userId &&
							row.badgeTokenId === input.badgeTokenId
					)
				)
					return false;
				rows.push({
					id: input.id,
					userId: input.userId,
					badgeTokenId: input.badgeTokenId,
					tierName: input.tierName,
					walletAddress: input.walletAddress,
					status: "pending",
					valueSnapshot: input.valueSnapshot,
					createdAt: input.nowIso,
					txHash: null,
					chainId: null,
					failureReason: null,
					confirmedAt: null,
				});
				return true;
			},
		},
	} as unknown as GatewayRepositories;
	const workspace = {
		id: "workspace:shared-organization",
		scopeType: "organization",
		role: "member",
		organizationId: "org:fixture",
		personalOwnerUserId: null,
	};
	const app = new Hono<UserEnv>();
	app.use("*", async (c, next) => {
		const principal = await authenticateUserRequest(
			c.req.raw,
			authenticationRepositories
		);
		if (!principal)
			return c.json({ success: false, message: "Unauthorized" }, 401, {
				"Cache-Control": "private, no-store",
			});
		c.set("principal", principal);
		c.set("repositories", repositories);
		c.env = {
			CHAIN_JOBS: {
				send: async (item: unknown) => {
					queue.push(item);
				},
			},
		} as unknown as UserEnv["Bindings"];
		await next();
	});
	app.use("*", userPrincipalPrecondition);
	app.use("*", async (c, next) => {
		workspaceResolutions.push(c.get("principal").userId);
		c.set("workspaceContext", {
			currentWorkspace: workspace,
			workspaces: [workspace],
			preferredWorkspaceAvailable: true,
		} as unknown as UserEnv["Variables"]["workspaceContext"]);
		await next();
	});
	app.use("*", userWorkspacePrecondition);
	app.route("/user/nft", userNftRoutes);

	function request(
		path: string,
		cookie: CookieIdentity,
		init: RequestInit = {}
	) {
		const headers = new Headers(init.headers);
		if (cookie !== null)
			headers.set("Cookie", `cinatoken_session=${tokens[cookie]}`);
		return new Request(
			new URL(path, "https://principal-fixture.example.test"),
			{ ...init, headers }
		);
	}
	function nftRequest(
		cookie: CookieIdentity,
		expectedUserId?: string,
		workspaceId = workspace.id,
		path = "/user/nft/mint"
	) {
		const method = path.endsWith("/mint") ? "POST" : "GET";
		const headers = new Headers({
			"X-CinaToken-Workspace": encodeURIComponent(workspaceId),
		});
		if (expectedUserId !== undefined)
			headers.set(
				USER_PRINCIPAL_PRECONDITION_HEADER,
				encodeURIComponent(expectedUserId)
			);
		if (method === "POST") headers.set("Content-Type", "application/json");
		return app.request(
			request(path, cookie, {
				method,
				headers,
				...(method === "POST"
					? { body: JSON.stringify({ badgeTokenId: 105 }) }
					: {}),
			})
		);
	}
	let browserCookie: CookieIdentity = "a";
	const browserRequests: {
		path: string;
		method: string;
		expectedUser: string | null;
		status: number;
	}[] = [];
	const browserFetch: typeof fetch = async (input, init = {}) => {
		const external = new URL(
			String(input),
			"https://principal-fixture.example.test"
		);
		const internalPath =
			external.pathname.replace(/^\/api\/user/, "/user") + external.search;
		const headers = new Headers(init.headers);
		const response = await app.request(
			request(internalPath, browserCookie, init)
		);
		browserRequests.push({
			path: external.pathname,
			method: init.method ?? "GET",
			expectedUser: headers.get(USER_PRINCIPAL_PRECONDITION_HEADER),
			status: response.status,
		});
		return response;
	};
	return {
		app,
		request,
		nftRequest,
		users,
		hashes,
		repositories,
		authenticationRepositories,
		workspace,
		authReads,
		ledgerReads,
		workspaceResolutions,
		configReads,
		rows,
		queue,
		deletedSessions,
		api: createCinaTokenApi(browserFetch),
		browserRequests,
		setBrowserCookie(value: CookieIdentity) {
			browserCookie = value;
		},
	};
}

function noDomainWork(f: Awaited<ReturnType<typeof fixture>>) {
	assert.equal(f.workspaceResolutions.length, 0);
	assert.equal(f.configReads.length, 0);
	assert.equal(f.ledgerReads.length, 0);
	assert.equal(f.rows.length, 0);
	assert.equal(f.queue.length, 0);
}

test("a shared Cookie switching A to B in the same organization workspace rejects actual SDK read/write before business effects", async () => {
	const f = await fixture();
	const scope = {
		expectedUserId: f.users.a.id,
		expectedWorkspaceId: f.workspace.id,
	};
	assert.equal((await f.api.nftTiers(scope)).sellerUserId, f.users.a.id);
	const before = {
		workspace: f.workspaceResolutions.length,
		config: f.configReads.length,
		ledger: f.ledgerReads.length,
	};
	f.setBrowserCookie("b");
	for (const operation of [
		() => f.api.nftTiers(scope),
		() => f.api.mintNft({ badgeTokenId: 105 }, scope),
	]) {
		await assert.rejects(
			operation,
			(error: unknown) =>
				error instanceof CinaTokenApiError &&
				error.code === "user-mismatch" &&
				error.status === 409 &&
				error.serverCode === "user_mismatch"
		);
	}
	assert.deepEqual(
		f.browserRequests.map((r) => r.status),
		[200, 409, 409]
	);
	assert.ok(f.browserRequests.every((r) => r.expectedUser === f.users.a.id));
	assert.equal(f.workspaceResolutions.length, before.workspace);
	assert.equal(f.configReads.length, before.config);
	assert.equal(f.ledgerReads.length, before.ledger);
	assert.equal(f.rows.length, 0);
	assert.equal(f.queue.length, 0);
	assert.ok(f.authReads.includes(f.users.b.subject));
});

test("same-workspace stale user conflicts are private and precede both a read and POST body validation", async () => {
	for (const [path, method, body] of [
		["/user/nft/tiers", "GET", undefined],
		["/user/nft/mint", "POST", "not JSON"],
	] as const) {
		const f = await fixture();
		const response = await f.app.request(
			f.request(path, "b", {
				method,
				body,
				headers: {
					[USER_PRINCIPAL_PRECONDITION_HEADER]: f.users.a.id,
					"X-CinaToken-Workspace": encodeURIComponent(f.workspace.id),
				},
			})
		);
		assert.equal(response.status, 409);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		assert.equal(
			((await response.json()) as { code: string }).code,
			"user_mismatch"
		);
		noDomainWork(f);
	}
});

test("valid A read and mint still use the authenticated personal owner while ignoring foreign body selectors", async () => {
	const f = await fixture();
	assert.equal(
		(await f.nftRequest("a", f.users.a.id, f.workspace.id, "/user/nft/tiers"))
			.status,
		200
	);
	const response = await f.app.request(
		f.request("/user/nft/mint", "a", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				[USER_PRINCIPAL_PRECONDITION_HEADER]: f.users.a.id,
			},
			body: JSON.stringify({
				badgeTokenId: 105,
				userId: f.users.b.id,
				walletAddress: "foreign",
				workspaceId: "foreign",
			}),
		})
	);
	assert.equal(response.status, 200);
	assert.equal(f.rows.length, 1);
	assert.equal(f.rows[0].userId, f.users.a.id);
	assert.equal(f.rows[0].valueSnapshot, 25.123456);
	assert.equal(f.rows[0].status, "pending");
	assert.equal(f.queue.length, 1);
	assert.ok(f.ledgerReads.every((userId) => userId === f.users.a.id));
});

test("matching user with an old workspace remains a distinct workspace conflict without ledger access", async () => {
	const f = await fixture();
	const response = await f.nftRequest("a", f.users.a.id, "workspace:old");
	assert.equal(response.status, 409);
	assert.equal(
		((await response.json()) as { code: string }).code,
		"workspace_mismatch"
	);
	assert.equal(f.workspaceResolutions.length, 1);
	assert.equal(f.configReads.length, 0);
	assert.equal(f.ledgerReads.length, 0);
	assert.equal(f.rows.length, 0);
	assert.equal(f.queue.length, 0);
});

test("an anonymous request cannot authenticate by supplying a matching expected user header", async () => {
	const f = await fixture();
	const response = await f.nftRequest(null, f.users.a.id);
	assert.equal(response.status, 401);
	noDomainWork(f);
});

test("header-less legacy clients remain authenticated as their actual Cookie user", async () => {
	const f = await fixture();
	assert.equal((await f.nftRequest("b")).status, 200);
	assert.equal(f.rows.length, 1);
	assert.equal(f.rows[0].userId, f.users.b.id);
	assert.equal(f.queue.length, 1);
});

test("canonical Unicode and encoded comma IDs pass without becoming a second user selector", async () => {
	const f = await fixture("用户,甲");
	const response = await f.nftRequest("a", f.users.a.id);
	assert.equal(response.status, 200);
	assert.equal(f.rows[0].userId, "用户,甲");
	assert.equal(f.queue.length, 1);
});

test("malformed, oversized, control-bearing and duplicate user headers fail before workspace or NFT work", async () => {
	for (const raw of [
		"%",
		"u".repeat(601),
		"a%00b",
		"a%C2%85b",
		"user-a,user-b",
	]) {
		const f = await fixture();
		const headers = new Headers({ [USER_PRINCIPAL_PRECONDITION_HEADER]: raw });
		if (raw === "user-a,user-b")
			headers.append(USER_PRINCIPAL_PRECONDITION_HEADER, "user-c");
		const response = await f.app.request(
			f.request("/user/nft/mint", "a", {
				method: "POST",
				headers,
				body: "not JSON",
			})
		);
		assert.equal(response.status, 400, raw);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		assert.equal(
			((await response.json()) as { code: string }).code,
			"invalid_user_precondition"
		);
		noDomainWork(f);
	}
});

test("the production User app rejects an authenticated wrong principal before attempting its real workspace resolver", async () => {
	const f = await fixture();
	let storageQueries = 0;
	const guardedRepositories = {
		...f.repositories,
		client: {
			driver: "d1",
			raw: {
				prepare: () => {
					storageQueries += 1;
					throw new Error("Workspace resolver must not run");
				},
			},
		},
	} as unknown as GatewayRepositories;
	for (const path of [
		"/user/nft/tiers",
		"/user/nft/mint",
		"/user/workspaces",
	]) {
		const request = f.request(path, "b", {
			method: path.endsWith("/mint") ? "POST" : "GET",
			headers: { [USER_PRINCIPAL_PRECONDITION_HEADER]: f.users.a.id },
		});
		const principal = await authenticateUserRequest(
			request,
			f.authenticationRepositories
		);
		assert.equal(principal?.userId, f.users.b.id);
		const response = await createUserApp().request(request, undefined, {
			STORAGE_CONTEXT: { repositories: guardedRepositories },
			USER_PRINCIPAL: principal,
		} as unknown as UserEnv["Bindings"]);
		assert.equal(response.status, 409);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		assert.equal(
			((await response.json()) as { code: string }).code,
			"user_mismatch"
		);
	}
	assert.equal(storageQueries, 0);
	noDomainWork(f);
});

test("the actual User logout retains identity protection while working after the preferred workspace is lost", async () => {
	for (const expected of ["matching", "omitted", "mismatched"] as const) {
		const f = await fixture();
		let storageQueries = 0;
		const guardedRepositories = {
			...f.repositories,
			client: {
				driver: "d1",
				raw: {
					prepare: () => {
						storageQueries += 1;
						throw new Error("Lost workspace must not be resolved for logout");
					},
				},
			},
		} as unknown as GatewayRepositories;
		const headers = new Headers({
			"X-CinaToken-Workspace": "workspace%3Aremoved",
		});
		if (expected !== "omitted")
			headers.set(
				USER_PRINCIPAL_PRECONDITION_HEADER,
				expected === "matching" ? f.users.b.id : f.users.a.id
			);
		const request = f.request("/user/auth/logout", "b", {
			method: "POST",
			headers,
		});
		const principal = await authenticateUserRequest(
			request,
			f.authenticationRepositories
		);
		const response = await createUserApp().request(request, undefined, {
			STORAGE_CONTEXT: { repositories: guardedRepositories },
			USER_PRINCIPAL: principal,
		} as unknown as UserEnv["Bindings"]);
		assert.equal(storageQueries, 0);
		if (expected === "mismatched") {
			assert.equal(response.status, 409);
			assert.equal(
				((await response.json()) as { code: string }).code,
				"user_mismatch"
			);
			assert.equal(f.deletedSessions.length, 0);
		} else {
			assert.equal(response.status, 200);
			assert.deepEqual(f.deletedSessions, [
				{ repository: "portal", tokenHash: f.hashes.b },
				{ repository: "admin", tokenHash: f.hashes.b },
			]);
			const cookies = response.headers.getSetCookie();
			for (const name of [
				"cinatoken_session",
				"user_session",
				"admin_session",
			]) {
				assert.ok(
					cookies.some(
						(cookie) =>
							cookie.startsWith(name + "=") && cookie.includes("Max-Age=0")
					)
				);
			}
			assert.equal(cookies.length, 4);
		}
		noDomainWork(f);
	}
});
