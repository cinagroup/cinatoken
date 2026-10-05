import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type {
	AddRequestPresetVersionParams,
	CreateRequestPresetParams,
	GatewayRepositories,
	RequestPresetVersionRow,
	RequestPresetWithVersionRow,
	UpdateRequestPresetMetadataPatch,
} from "@octafuse/core";
import type { UserEnv } from "@/lib/user-env";
import { userPresetsRoutes } from "@/lib/routes/user/presets";

function fixture(
	capable = true,
	workspace = "workspace:team",
	owner = "user:alice"
) {
	const reads: string[] = [],
		writes: string[] = [];
	const rows = new Map<string, RequestPresetWithVersionRow>();
	const histories = new Map<string, RequestPresetVersionRow[]>();
	function project(
		row: RequestPresetWithVersionRow,
		version: RequestPresetVersionRow
	): RequestPresetWithVersionRow {
		return {
			...row,
			version_id: version.id,
			version_system_prompt: version.system_prompt,
			version_config_json: version.config_json,
			version_created_by_user_id: version.created_by_user_id,
			version_created_at: version.created_at,
		};
	}
	const requestPresets = {
		listOwnedByWorkspace: async (
			id: string,
			userId: string,
			includeArchived: boolean
		) => {
			reads.push("list");
			assert.equal(includeArchived, true);
			return [...rows.values()].filter(
				(row) => row.workspace_id === id && row.owner_user_id === userId
			);
		},
		getBySlug: async (slug: string, workspaceId: string) => {
			reads.push("slug");
			return (
				[...rows.values()].find(
					(row) => row.workspace_id === workspaceId && row.slug === slug
				) ?? null
			);
		},
		getById: async (id: string) => {
			reads.push("id");
			return rows.get(id) ?? null;
		},
		getByIdInWorkspace: async (id: string, workspaceId: string) => {
			reads.push("scoped-id");
			const row = rows.get(id);
			return row?.workspace_id === workspaceId ? row : null;
		},
		listVersions: async (id: string) => {
			reads.push("versions");
			return histories.get(id) ?? [];
		},
		createWithVersion: async (input: CreateRequestPresetParams) => {
			writes.push("create");
			const version = {
				id: input.versionId,
				preset_id: input.id,
				version: 1,
				system_prompt: input.systemPrompt,
				config_json: input.configJson,
				created_by_user_id: input.createdByUserId,
				created_at: input.nowIso,
			};
			const row = project(
				{
					id: input.id,
					workspace_id: input.workspaceId,
					owner_user_id: input.ownerUserId,
					slug: input.slug,
					name: input.name,
					description: input.description,
					visibility: input.visibility,
					status: "active",
					designated_version: 1,
					latest_version: 1,
					created_at: input.nowIso,
					updated_at: input.nowIso,
				} as RequestPresetWithVersionRow,
				version
			);
			rows.set(row.id, row);
			histories.set(row.id, [version]);
			return row;
		},
		addVersion: async (input: AddRequestPresetVersionParams) => {
			writes.push("version");
			const previous = rows.get(input.presetId)!;
			const number = previous.latest_version + 1;
			const version = {
				id: input.versionId,
				preset_id: input.presetId,
				version: number,
				system_prompt: input.systemPrompt,
				config_json: input.configJson,
				created_by_user_id: input.createdByUserId,
				created_at: input.nowIso,
			};
			const updated = project(
				{
					...previous,
					latest_version: number,
					designated_version: number,
					updated_at: input.nowIso,
				},
				version
			);
			rows.set(updated.id, updated);
			histories.get(updated.id)!.push(version);
			return updated;
		},
		updateMetadata: async (
			id: string,
			patch: UpdateRequestPresetMetadataPatch
		) => {
			writes.push("metadata");
			const previous = rows.get(id)!;
			const { nowIso, ...metadata } = patch;
			rows.set(id, { ...previous, ...metadata, updated_at: nowIso });
			return true;
		},
		designateVersion: async (id: string, version: number, nowIso: string) => {
			writes.push("designate");
			const previous = rows.get(id)!;
			const selected = histories
				.get(id)
				?.find((item) => item.version === version);
			if (!selected || previous.status === "archived") return false;
			rows.set(
				id,
				project(
					{ ...previous, designated_version: version, updated_at: nowIso },
					selected
				)
			);
			return true;
		},
	};
	const app = new Hono<UserEnv>();
	app.use("*", async (c, next) => {
		c.set("repositories", { requestPresets } as unknown as GatewayRepositories);
		c.set("principal", {
			userId: owner,
			subject: "subject:alice",
			email: "alice@example.test",
			isAdmin: true,
			capabilities: capable ? ["account.read"] : ["admin.console"],
		});
		c.set("workspaceContext", {
			workspaces: [],
			currentWorkspace: {
				id: workspace,
				scopeType: "organization",
				role: "member",
			},
		} as unknown as UserEnv["Variables"]["workspaceContext"]);
		await next();
	});
	app.route("/presets", userPresetsRoutes);
	const request = (path = "", method = "GET", body?: unknown) =>
		app.request("/presets" + path, {
			method,
			...(body === undefined
				? {}
				: {
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(body),
				  }),
		});
	return { app, request, rows, histories, reads, writes, requestPresets };
}
const save = {
	slug: "@preset/Analysis",
	name: "Analysis",
	description: "Work",
	visibility: "private",
	systemPrompt: "Be precise.",
	config: {
		model: "model-a",
		temperature: 0.2,
		thinking: { type: "enabled", budget_tokens: 1024 },
	},
};
test("every preset operation requires account.read and private no-store before any repository read", async () => {
	for (const [path, method, body] of [
		["", "GET"],
		["", "POST", save],
		["/p/versions", "GET"],
		["/p", "PATCH", { visibility: "public" }],
		["/p/designate", "POST", { version: 1 }],
		["/p", "DELETE"],
	] as const) {
		const context = fixture(false);
		const response = await context.request(path, method, body);
		assert.equal(response.status, 403);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		assert.deepEqual(context.reads, []);
		assert.deepEqual(context.writes, []);
	}
});
test("organization member saves their own preset; a new version immediately becomes designated without mutating history", async () => {
	const context = fixture();
	let response = await context.request("", "POST", save);
	assert.equal(response.status, 201);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	const first = (await response.json()) as {
		data: {
			id: string;
			slug: string;
			designatedVersion: number;
			latestVersion: number;
		};
	};
	assert.equal(first.data.slug, "analysis");
	assert.equal(first.data.designatedVersion, 1);
	response = await context.request("", "POST", {
		...save,
		config: { model: "model-b", max_output_tokens: 200 },
	});
	const second = (await response.json()) as {
		data: {
			designatedVersion: number;
			latestVersion: number;
			config: { model: string };
		};
	};
	assert.equal(second.data.latestVersion, 2);
	assert.equal(second.data.designatedVersion, 2);
	assert.equal(second.data.config.model, "model-b");
	const history = (await (
		await context.request("/" + first.data.id + "/versions")
	).json()) as {
		workspaceId: string;
		presetId: string;
		ownerUserId: string;
		data: { version: number; config: { model: string } }[];
	};
	assert.equal(history.workspaceId, "workspace:team");
	assert.equal(history.presetId, first.data.id);
	assert.equal(history.ownerUserId, "user:alice");
	assert.deepEqual(
		history.data.map((row) => row.config.model),
		["model-a", "model-b"]
	);
	const changed = await context.request(
		"/" + first.data.id + "/designate",
		"POST",
		{ version: 1 }
	);
	const selected = (await changed.json()) as {
		data: {
			designatedVersion: number;
			latestVersion: number;
			config: { model: string };
		};
	};
	assert.equal(selected.data.designatedVersion, 1);
	assert.equal(selected.data.latestVersion, 2);
	assert.equal(selected.data.config.model, "model-a");
});
test("metadata visibility/archive/restore and DELETE-as-archive preserve versions", async () => {
	const context = fixture();
	const created = (await (await context.request("", "POST", save)).json()) as {
		data: { id: string };
	};
	const path = "/" + created.data.id;
	let response = await context.request(path, "PATCH", {
		visibility: "public",
		name: "Updated",
		description: null,
	});
	assert.equal(response.status, 200);
	assert.equal(context.rows.get(created.data.id)?.visibility, "public");
	response = await context.request(path, "DELETE");
	assert.equal(response.status, 200);
	assert.equal(context.rows.get(created.data.id)?.status, "archived");
	assert.equal(context.histories.get(created.data.id)?.length, 1);
	assert.equal((await context.request("", "POST", save)).status, 409);
	assert.equal(
		(await context.request(path + "/designate", "POST", { version: 1 })).status,
		404
	);
	assert.equal(
		(
			await context.request(path, "PATCH", {
				status: "active",
				visibility: "private",
			})
		).status,
		200
	);
	assert.equal((await context.request("", "POST", save)).status, 201);
});
test("workspace membership or console admin does not grant access to another user or workspace preset", async () => {
	const context = fixture();
	const created = (await (await context.request("", "POST", save)).json()) as {
		data: { id: string };
	};
	const current = context.rows.get(created.data.id)!;
	for (const mismatch of [
		{ owner_user_id: "user:other" },
		{ workspace_id: "workspace:other" },
	]) {
		context.rows.set(current.id, { ...current, ...mismatch });
		for (const [suffix, method, body] of [
			["/versions", "GET"],
			["", "PATCH", { visibility: "public" }],
			["/designate", "POST", { version: 1 }],
			["", "DELETE"],
		] as const)
			assert.equal(
				(await context.request("/" + current.id + suffix, method, body)).status,
				404
			);
	}
	context.rows.set(current.id, { ...current, owner_user_id: "user:other" });
	assert.equal((await context.request("", "POST", save)).status, 403);
	const collection = (await (await context.request()).json()) as {
		data: { workspaceId: string; ownerUserId: string; presets: unknown[] };
	};
	assert.deepEqual(collection.data, {
		workspaceId: "workspace:team",
		ownerUserId: "user:alice",
		presets: [],
	});
});
test("empty version history still identifies its authorized owner and resource; invalid configuration is rejected before writes", async () => {
	const context = fixture();
	const created = (await (await context.request("", "POST", save)).json()) as {
		data: { id: string };
	};
	context.histories.set(created.data.id, []);
	const history = (await (
		await context.request("/" + created.data.id + "/versions")
	).json()) as {
		workspaceId: string;
		presetId: string;
		ownerUserId: string;
		data: unknown[];
	};
	assert.equal(history.presetId, created.data.id);
	assert.deepEqual(history.data, []);
	const count = context.writes.length;
	for (const patch of [
		{ config: { messages: [] } },
		{ config: { model: "@preset/nested" } },
		{
			config: { provider: { headers: { Authorization: "synthetic-secret" } } },
		},
		{ config: { model: "x".repeat(65536) } },
		{ systemPrompt: "界".repeat(11000) },
		{ systemPrompt: 5 },
	]) {
		const response = await context.request("", "POST", { ...save, ...patch });
		assert.equal(response.status, 400);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
	}
	assert.equal(context.writes.length, count);
	const malformed = await context.app.request("/presets", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: "{",
	});
	assert.equal(malformed.status, 400);
	assert.equal(malformed.headers.get("cache-control"), "private, no-store");
});
