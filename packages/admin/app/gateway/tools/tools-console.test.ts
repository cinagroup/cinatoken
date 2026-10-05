import assert from "node:assert/strict";
import test from "node:test";
import {
	createToolsConsoleSession,
	toolsConsoleReader,
	type ToolsConsoleState,
	type ToolsConsoleIdentity,
} from "./tools-console";
import { ToolWriteRecovery } from "@cinatoken/web/src/cinatoken/admin/tools/tools-recovery";
import { configAccessIdentityKey } from "@cinatoken/web/src/cinatoken/admin/config/config-access-recovery";

const portalMe = (subject: string) => ({
	userId: "portal-user",
	subject,
	email: "fixture@example.test",
	isAdmin: true,
	capabilities: [],
	organizations: [],
});

test("legacy Tools accepts only a fresh verified Console subject through the private cookie transport", async () => {
	const body = {
		authenticated: true,
		verification: "verified",
		principalType: "console",
		subject: "subject:工具",
	};
	const calls: Array<{ url: string; options?: RequestInit }> = [];
	const request: typeof fetch = async (input, options) => {
		calls.push({ url: String(input), options });
		return Response.json(
			String(input) === "/api/user/me"
				? { success: true, data: portalMe(body.subject) }
				: body
		);
	};
	assert.deepEqual(
		await toolsConsoleReader(request)(new AbortController().signal),
		{ userId: "portal-user", subject: body.subject }
	);
	assert.equal(calls.length, 2);
	assert.equal(calls[0].url, "/api/auth/check");
	assert.equal(calls[0].options?.credentials, "same-origin");
	assert.equal(calls[0].options?.cache, "no-store");
	assert.equal(calls[0].options?.redirect, "error");
	assert.equal(
		new Headers(calls[0].options?.headers).has("Authorization"),
		false
	);
	for (const change of [
		{ authenticated: false },
		{ verification: "degraded" },
		{ verification: "rejected" },
		{ principalType: "api_key" },
		{ subject: undefined },
		{ subject: " value " },
		{ subject: "bad\u0000subject" },
		{ subject: "bad\u200bsubject" },
		{ subject: "😀".repeat(301) },
	]) {
		await assert.rejects(
			toolsConsoleReader(async (input) =>
				Response.json(
					String(input) === "/api/user/me"
						? { success: true, data: portalMe(body.subject) }
						: { ...body, ...change }
				)
			)(new AbortController().signal)
		);
	}
	await assert.rejects(
		toolsConsoleReader(async (input) =>
			Response.json(
				String(input) === "/api/user/me"
					? { success: true, data: portalMe("different") }
					: body
			)
		)(new AbortController().signal)
	);
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

test("a newer identity recheck wins even when an older response ignores cancellation", async () => {
	const first = deferred<ToolsConsoleIdentity>(),
		second = deferred<ToolsConsoleIdentity>();
	const states: ToolsConsoleState[] = [],
		signals: AbortSignal[] = [];
	const pending = [first, second];
	const session = createToolsConsoleSession(
		(signal) => {
			signals.push(signal);
			return pending.shift()!.promise;
		},
		(value) => states.push(value)
	);
	const one = session.revalidate(),
		two = session.revalidate();
	assert.equal(signals[0].aborted, true);
	second.resolve({ userId: "current-user", subject: "current" });
	await two;
	first.resolve({ userId: "old-user", subject: "previous" });
	await one;
	assert.deepEqual(states.slice(0, 2), [
		{ state: "checking" },
		{ state: "checking" },
	]);
	assert.equal(states.length, 3);
	const current = states.at(-1);
	assert.equal(current?.state, "ready");
	if (current?.state !== "ready") assert.fail();
	assert.equal(current.subject, "current");
	assert.deepEqual(JSON.parse(current.reconciliationKey), [
		"current-user",
		"current",
		2,
	]);
});

test("recheck remounts the editor without changing the durable unknown-result identity", async () => {
	const states: ToolsConsoleState[] = [];
	const session = createToolsConsoleSession(
		async () => ({ userId: "same-user", subject: "same" }),
		(value) => states.push(value)
	);
	await session.revalidate();
	await session.revalidate();
	const ready = states.filter((value) => value.state === "ready");
	assert.equal(ready.length, 2);
	assert.notEqual(ready[0].scopeKey, ready[1].scopeKey);
	assert.equal(
		configAccessIdentityKey(ready[0].reconciliationKey),
		configAccessIdentityKey(ready[1].reconciliationKey)
	);
});

test("hidden, expired and disposed sessions cannot revive an old editor or reflect auth secrets", async () => {
	for (const dispose of [false, true]) {
		const pending = deferred<ToolsConsoleIdentity>(),
			states: ToolsConsoleState[] = [];
		const session = createToolsConsoleSession(
			() => pending.promise,
			(value) => states.push(value)
		);
		const checking = session.revalidate();
		if (dispose) session.dispose();
		else session.invalidate();
		pending.resolve({ userId: "late-user", subject: "late-subject" });
		await checking;
		assert.deepEqual(states, [{ state: "checking" }, { state: "unverified" }]);
		if (dispose) {
			await session.revalidate();
			assert.equal(states.length, 2);
		}
	}
	const states: ToolsConsoleState[] = [];
	const session = createToolsConsoleSession(
		async () => {
			throw new Error("raw-credential");
		},
		(value) => states.push(value)
	);
	await session.revalidate();
	assert.deepEqual(states, [{ state: "checking" }, { state: "unverified" }]);
	assert.doesNotMatch(JSON.stringify(states), /raw-credential/u);
});

test("an unknown write remains locked when the same tab changes from Next to the Web Console", async () => {
	const states: ToolsConsoleState[] = [],
		saved = new Map<string, string>();
	const recovery = new ToolWriteRecovery(
		{
			getItem: (key) => saved.get(key) ?? null,
			setItem: (key, value) => {
				saved.set(key, value);
			},
			removeItem: (key) => {
				saved.delete(key);
			},
		},
		true
	);
	const session = createToolsConsoleSession(
		async () => ({ userId: "same-user", subject: "same-subject" }),
		(value) => states.push(value)
	);
	await session.revalidate();
	const ready = states.at(-1);
	if (ready?.state !== "ready") assert.fail();
	const marker = recovery.markPending(ready.reconciliationKey, {
		family: "web-search",
		provider: "tavily",
		operation: "save",
	});
	const webIdentity = JSON.stringify(["same-user", "same-subject", 94]);
	assert.equal(recovery.status(webIdentity), "pending");
	assert.deepEqual(recovery.marker(webIdentity), marker);
	assert.equal(
		recovery.status(JSON.stringify(["other-user", "same-subject", 94])),
		"ready"
	);
});
