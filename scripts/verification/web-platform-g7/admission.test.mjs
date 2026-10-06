import assert from "node:assert/strict";
import { test } from "node:test";
import {
	admit,
	assertOwned,
	assertTopology,
	OWNER_LABEL,
	boundedCommandTimeout,
} from "./admission.mjs";

const sha = "a".repeat(40);
const args = ["--execute-owned-linux", "--sha", sha, "--out", "/tmp/g7-new"];
const env = { GITHUB_ACTIONS: "true", GITHUB_SHA: sha };
test("command budget never admits zero, negative or oversized remaining timeout", () => {
	assert.equal(boundedCommandTimeout(1_100, 900, 500, 1_000), 100);
	assert.equal(boundedCommandTimeout(5_000, 900, 500, 1_000), 500);
	for (const now of [1_100, 1_101])
		assert.throws(() => boundedCommandTimeout(1_100, 900, 500, now));
	assert.throws(() => boundedCommandTimeout(1_100, 0, 500, 1_000));
});
test("execution admission rejects wrong SHA, platform, endpoint and TLS bypass", () => {
	assert.equal(admit(args, env, "linux").sha, sha);
	for (const changed of [
		{ ...env, GITHUB_SHA: "b".repeat(40) },
		{ ...env, GITHUB_ACTIONS: "false" },
		{ ...env, DOCKER_HOST: "tcp://remote:2375" },
		{ ...env, DOCKER_CONTEXT: "remote" },
		{ ...env, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
	])
		assert.throws(() => admit(args, changed, "linux"));
	assert.throws(() => admit(args, env, "win32"));
	assert.throws(() => admit([...args, "--skip"], env, "linux"));
	assert.throws(() => admit([...args.slice(0, 4), "relative"], env, "linux"));
});
test("cleanup ownership never admits foreign or unlabeled resources", () => {
	const owner = `g7-${"a".repeat(32)}`;
	assert.doesNotThrow(() => assertOwned({ [OWNER_LABEL]: owner }, owner));
	assert.throws(() => assertOwned({}, owner));
	assert.throws(() => assertOwned({ [OWNER_LABEL]: `${owner}foreign` }, owner));
});
test("topology rejects public ports, extra networks and writable input mounts", () => {
	const base = {
		HostConfig: { Privileged: false, NetworkMode: "edge", PortBindings: {} },
		NetworkSettings: { Networks: { edge: {} } },
		Mounts: [{ Destination: "/qa", RW: false }],
	};
	assert.doesNotThrow(() => assertTopology(base, ["edge"]));
	for (const mutate of [
		(v) => {
			v.HostConfig.Privileged = true;
		},
		(v) => {
			v.HostConfig.PortBindings = { "443/tcp": [{ HostPort: "443" }] };
		},
		(v) => {
			v.NetworkSettings.Networks.bridge = {};
		},
		(v) => {
			v.Mounts[0].RW = true;
		},
	]) {
		const value = structuredClone(base);
		mutate(value);
		assert.throws(() => assertTopology(value, ["edge"]));
	}
});
