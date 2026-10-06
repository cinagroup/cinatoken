import assert from "node:assert/strict";
import { isAbsolute } from "node:path";

export const OWNER_LABEL = "cinatoken.g7.owner";
export const APP_ORIGIN = "https://app.test";
export const PUBLIC_API_ORIGIN = "http://gateway-proxy:8787";

export function boundedCommandTimeout(
	deadline,
	requested,
	ceiling = requested,
	now = Date.now()
) {
	for (const value of [deadline, requested, ceiling, now])
		assert.ok(Number.isInteger(value));
	assert.ok(requested > 0 && ceiling > 0);
	const remaining = deadline - now;
	assert.ok(
		remaining > 0,
		"Owned command deadline exceeded; zero timeout is forbidden"
	);
	return Math.min(requested, ceiling, remaining);
}

export function admit(argv, env, platform) {
	assert.equal(platform, "linux", "Real Docker acceptance requires Linux");
	assert.equal(
		env.GITHUB_ACTIONS,
		"true",
		"Owned GitHub Linux runner required"
	);
	assert.equal(
		env.NODE_TLS_REJECT_UNAUTHORIZED,
		undefined,
		"TLS bypass forbidden"
	);
	assert.equal(
		env.DOCKER_CONTEXT,
		undefined,
		"Inherited Docker context forbidden"
	);
	assert.equal(
		env.DOCKER_HOST,
		undefined,
		"Inherited Docker endpoint forbidden"
	);
	assert.equal(
		argv.length,
		5,
		"Use --execute-owned-linux --sha SHA --out NEW_DIRECTORY"
	);
	assert.equal(argv[0], "--execute-owned-linux");
	assert.equal(argv[1], "--sha");
	assert.match(argv[2], /^[a-f0-9]{40}$/);
	assert.equal(env.GITHUB_SHA, argv[2], "Exact workflow SHA required");
	assert.equal(argv[3], "--out");
	assert.ok(isAbsolute(argv[4]), "Absolute new receipt directory required");
	return { sha: argv[2], out: argv[4] };
}

export function assertOwned(value, owner) {
	assert.match(owner, /^g7-[a-f0-9]{32}$/);
	assert.equal(
		value?.[OWNER_LABEL],
		owner,
		"Refuse to remove unowned Docker object"
	);
}

export function assertTopology(container, networks, writableDestinations = []) {
	assert.equal(container.HostConfig.Privileged, false);
	assert.equal(container.HostConfig.NetworkMode, networks[0]);
	assert.ok(!container.HostConfig.PublishAllPorts);
	assert.equal(Object.keys(container.HostConfig.PortBindings ?? {}).length, 0);
	assert.deepEqual(
		Object.keys(container.NetworkSettings.Networks).sort(),
		[...networks].sort()
	);
	for (const mount of container.Mounts) {
		assert.equal(
			mount.RW,
			writableDestinations.includes(mount.Destination),
			`Unexpected mount permission: ${mount.Destination}`
		);
	}
}
