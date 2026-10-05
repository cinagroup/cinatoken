import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type {
	GatewayRepositories,
	RequestPresetVersionRow,
	RequestPresetWithVersionRow,
	UpdateRequestPresetMetadataPatch,
} from "@octafuse/core";
import type { AdminEnv } from "@/lib/admin-env";
import { getAdminAuthorizationDecision } from "@/lib/admin-permissions";
import {
	hasAdminPermission,
	type AdminPermission,
	type AdminPrincipal,
} from "@/lib/admin-principal";
import { adminPresetsRoutes } from "./presets";

const secretPrompt = "PRIVATE_SYSTEM_PROMPT_SENTINEL";
const secretConfig = "PRIVATE_CONFIG_SENTINEL";

const initialRow: RequestPresetWithVersionRow = {
	id: "preset-1",
	workspace_id: "other-workspace",
	owner_user_id: "other-user",
	slug: "research",
	name: "Research",
	description: "Describe responses",
	visibility: "private",
	status: "active",
	designated_version: 1,
	latest_version: 2,
	created_at: "2026-09-01T00:00:00.000Z",
	updated_at: "2026-09-02T00:00:00.000Z",
	version_id: "version-1",
	version_system_prompt: secretPrompt,
	version_config_json: JSON.stringify({
		model: "provider/model-1",
		apiKey: secretConfig,
	}),
	version_created_by_user_id: "user-1",
	version_created_at: "2026-09-01T00:00:00.000Z",
};

const initialVersion: RequestPresetVersionRow = {
	id: "version-1",
	preset_id: initialRow.id,
	version: 1,
	system_prompt: secretPrompt,
	config_json: JSON.stringify({
		model: "provider/model-1",
		apiKey: secretConfig,
	}),
	created_by_user_id: "user-1",
	created_at: "2026-09-01T00:00:00.000Z",
};

function fixture(
	options: {
		principal?: AdminPrincipal | null;
		rows?: RequestPresetWithVersionRow[];
		versions?: RequestPresetVersionRow[];
		fail?: "list" | "versions" | "update" | "designate";
		missingAfterWrite?: boolean;
	} = {}
) {
	let rows = options.rows ?? [{ ...initialRow }];
	let writeHappened = false;
	const versions = options.versions ?? [{ ...initialVersion }];
	const calls: string[] = [];
	const repositories = {
		requestPresets: {
			listAll: async (includeArchived: boolean) => {
				calls.push(`list:${includeArchived}`);
				if (options.fail === "list") throw new Error(secretConfig);
				return rows;
			},
			getById: async (id: string) => {
				calls.push(`get:${id}`);
				if (writeHappened && options.missingAfterWrite) return null;
				return rows.find((row) => row.id === id) ?? null;
			},
			listVersions: async (id: string) => {
				calls.push(`versions:${id}`);
				if (options.fail === "versions") throw new Error(secretConfig);
				return versions;
			},
			updateMetadata: async (
				id: string,
				patch: UpdateRequestPresetMetadataPatch
			) => {
				calls.push(`update:${id}`);
				if (options.fail === "update") throw new Error(secretConfig);
				writeHappened = true;
				rows = rows.map((row) =>
					row.id === id
						? {
								...row,
								name: patch.name ?? row.name,
								description:
									patch.description === undefined
										? row.description
										: patch.description,
								visibility: patch.visibility ?? row.visibility,
								status: patch.status ?? row.status,
						  }
						: row
				);
				return true;
			},
			designateVersion: async (id: string, version: number) => {
				calls.push(`designate:${id}:${version}`);
				if (options.fail === "designate") throw new Error(secretConfig);
				if (
					!rows.some((row) => row.id === id) ||
					!versions.some((item) => item.version === version)
				)
					return false;
				writeHappened = true;
				rows = rows.map((row) =>
					row.id === id ? { ...row, designated_version: version } : row
				);
				return true;
			},
		},
	} as unknown as GatewayRepositories;
	const app = new Hono<AdminEnv>();
	const principal =
		options.principal === undefined
			? ({
					type: "console",
					id: "console:test",
					username: "test",
			  } as const satisfies AdminPrincipal)
			: options.principal;
	app.use("*", async (c, next) => {
		if (!principal)
			return c.json({ success: false, message: "Unauthorized" }, 401);
		const decision = getAdminAuthorizationDecision(c.req.method, c.req.path);
		if (
			decision.kind !== "permission" ||
			!hasAdminPermission(principal, decision.permission)
		) {
			return c.json({ success: false, message: "Forbidden" }, 403);
		}
		c.set("principal", principal);
		c.set("repositories", repositories);
		await next();
	});
	app.route("/admin/presets", adminPresetsRoutes);
	return { app, calls };
}

function adminKey(permissions: AdminPermission[]): AdminPrincipal {
	return { type: "api_key", id: "admin_key:test", keyId: "test", permissions };
}

function assertPrivate(response: Response) {
	assert.equal(response.headers.get("cache-control"), "private, no-store");
}

test("summary list is global, minimal, no-store, and preserves empty collections", async () => {
	const { app, calls } = fixture();
	const response = await app.request("/admin/presets/summaries");
	assert.equal(response.status, 200);
	assertPrivate(response);
	const body = await response.text();
	assert.equal(
		body.includes(secretPrompt) || body.includes(secretConfig),
		false
	);
	assert.deepEqual(JSON.parse(body), {
		success: true,
		count: 1,
		canWrite: true,
		data: [
			{
				id: "preset-1",
				workspaceId: "other-workspace",
				ownerUserId: "other-user",
				slug: "research",
				name: "Research",
				description: "Describe responses",
				visibility: "private",
				status: "active",
				designatedVersion: 1,
				latestVersion: 2,
			},
		],
	});
	assert.deepEqual(calls, ["list:true"]);
	const empty = await fixture({ rows: [] }).app.request(
		"/admin/presets/summaries"
	);
	assert.equal(empty.status, 200);
	assertPrivate(empty);
	assert.deepEqual(await empty.json(), {
		success: true,
		data: [],
		count: 0,
		canWrite: true,
	});
});

test("version summaries expose only a bounded valid model, never raw configuration or prompt", async () => {
	const versions = [
		initialVersion,
		{ ...initialVersion, id: "bad-json", version: 2, config_json: "{invalid" },
		{
			...initialVersion,
			id: "bad-model",
			version: 3,
			config_json: JSON.stringify({ model: 42, secret: secretConfig }),
		},
		{
			...initialVersion,
			id: "long-model",
			version: 4,
			config_json: JSON.stringify({
				model: "x".repeat(257),
				secret: secretConfig,
			}),
		},
		{
			...initialVersion,
			id: "huge-config",
			version: 5,
			config_json: JSON.stringify({
				model: "valid",
				secret: "x".repeat(131_073),
			}),
		},
	];
	const { app } = fixture({ versions });
	const response = await app.request(
		"/admin/presets/preset-1/version-summaries"
	);
	assert.equal(response.status, 200);
	assertPrivate(response);
	const body = await response.text();
	assert.equal(
		body.includes(secretPrompt) || body.includes(secretConfig),
		false
	);
	assert.deepEqual(JSON.parse(body), {
		success: true,
		data: {
			presetId: "preset-1",
			total: 5,
			versions: versions.map((row, index) => ({
				id: row.id,
				version: row.version,
				createdAt: row.created_at,
				model: index === 0 ? "provider/model-1" : null,
			})),
		},
	});
});

test("legacy GET shapes remain compatible while explicit summary writes never return prompt/config", async () => {
	const { app } = fixture();
	for (const path of ["/admin/presets", "/admin/presets/preset-1/versions"]) {
		const response = await app.request(path);
		assert.equal(response.status, 200);
		assertPrivate(response);
		const body = await response.text();
		assert.equal(
			body.includes(secretPrompt) && body.includes(secretConfig),
			true
		);
	}
	const patch = await app.request("/admin/presets/preset-1?view=summary", {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name: "New name", status: "archived" }),
	});
	assert.equal(patch.status, 200);
	assertPrivate(patch);
	const patchText = await patch.text();
	assert.equal(
		patchText.includes(secretPrompt) || patchText.includes(secretConfig),
		false
	);
	assert.deepEqual(JSON.parse(patchText), {
		success: true,
		acknowledgement: { domain: "presets", operation: "update", id: "preset-1" },
		data: {
			id: "preset-1",
			workspaceId: "other-workspace",
			ownerUserId: "other-user",
			slug: "research",
			name: "New name",
			description: "Describe responses",
			visibility: "private",
			status: "archived",
			designatedVersion: 1,
			latestVersion: 2,
		},
	});
	const designate = await app.request(
		"/admin/presets/preset-1/designate?view=summary",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: '{"version":1}',
		}
	);
	assert.equal(designate.status, 200);
	assertPrivate(designate);
	assert.equal((await designate.text()).includes(secretPrompt), false);
	const legacyPatch = await app.request("/admin/presets/preset-1", {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: '{"visibility":"public"}',
	});
	assert.equal(legacyPatch.status, 200);
	assert.equal((await legacyPatch.text()).includes(secretPrompt), true);
	const legacyDesignate = await app.request(
		"/admin/presets/preset-1/designate",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: '{"version":1}',
		}
	);
	assert.equal(legacyDesignate.status, 200);
	assert.equal((await legacyDesignate.text()).includes(secretPrompt), true);
});

test("summary errors, invalid views, and storage failures are private and never leak raw details", async () => {
	for (const [path, request, status] of [
		["/admin/presets/missing/version-summaries", undefined, 404],
		["/admin/presets/preset-1?view=raw", { method: "PATCH", body: "{}" }, 400],
		[
			"/admin/presets/preset-1/designate?view=raw",
			{ method: "POST", body: "{}" },
			400,
		],
		[
			"/admin/presets/preset-1?view=summary",
			{ method: "PATCH", body: "{invalid" },
			400,
		],
		[
			"/admin/presets/preset-1/designate?view=summary",
			{ method: "POST", body: '{"version":0}' },
			400,
		],
	] as const) {
		const { app, calls } = fixture();
		const response = await app.request(path, request);
		assert.equal(response.status, status, path);
		assertPrivate(response);
		assert.equal((await response.text()).includes(secretConfig), false);
		assert.equal(
			calls.some(
				(call) => call.startsWith("update:") || call.startsWith("designate:")
			),
			false
		);
	}
	for (const [fail, path, request] of [
		["list", "/admin/presets/summaries", undefined],
		["versions", "/admin/presets/preset-1/version-summaries", undefined],
		[
			"update",
			"/admin/presets/preset-1?view=summary",
			{ method: "PATCH", body: "{}" },
		],
		[
			"designate",
			"/admin/presets/preset-1/designate?view=summary",
			{ method: "POST", body: '{"version":1}' },
		],
	] as const) {
		const { app } = fixture({ fail });
		const response = await app.request(path, request);
		assert.equal(response.status, 500, path);
		assertPrivate(response);
		const body = await response.text();
		assert.equal(
			body.includes(secretConfig) || body.includes(secretPrompt),
			false
		);
	}
});

test("admin permission mapping remains read/write and denies before repository access", async () => {
	for (const path of [
		"/admin/presets/summaries",
		"/admin/presets/preset-1/version-summaries",
	]) {
		assert.deepEqual(getAdminAuthorizationDecision("GET", path), {
			kind: "permission",
			permission: "presets.read",
		});
		const denied = fixture({ principal: adminKey([]) });
		assert.equal((await denied.app.request(path)).status, 403);
		assert.deepEqual(denied.calls, []);
		assert.equal(
			(
				await fixture({ principal: adminKey(["presets.read"]) }).app.request(
					path
				)
			).status,
			200
		);
	}
	for (const [method, path, body] of [
		["PATCH", "/admin/presets/preset-1?view=summary", "{}"],
		["POST", "/admin/presets/preset-1/designate?view=summary", '{"version":1}'],
	] as const) {
		assert.deepEqual(
			getAdminAuthorizationDecision(method, path.split("?")[0]),
			{ kind: "permission", permission: "presets.write" }
		);
		const denied = fixture({ principal: adminKey(["presets.read"]) });
		assert.equal(
			(await denied.app.request(path, { method, body })).status,
			403
		);
		assert.deepEqual(denied.calls, []);
	}
	const anonymous = fixture({ principal: null });
	assert.equal(
		(await anonymous.app.request("/admin/presets/summaries")).status,
		401
	);
	assert.deepEqual(anonymous.calls, []);
});

test("summary writes report an unknown outcome when the updated row cannot be read", async () => {
	for (const [path, method, body] of [
		["/admin/presets/preset-1?view=summary", "PATCH", "{}"],
		["/admin/presets/preset-1/designate?view=summary", "POST", '{"version":1}'],
	] as const) {
		const { app } = fixture({ missingAfterWrite: true });
		const response = await app.request(path, { method, body });
		assert.equal(response.status, 500);
		assertPrivate(response);
		assert.deepEqual(await response.json(), {
			success: false,
			message: "Failed to read updated preset",
		});
	}
});
