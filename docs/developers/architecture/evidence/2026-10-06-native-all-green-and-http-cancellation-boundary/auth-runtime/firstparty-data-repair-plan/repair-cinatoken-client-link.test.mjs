import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { repairCinatokenClientLink } from "./repair-cinatoken-client-link.mjs";

const CLIENT = "cinatoken-admin";
const RESOURCE = "https://cinatoken.com";
const beforeMissingLink = { clientExists: true, clientDisabled: false, resourceExists: true, resourceDisabled: false, linkExists: false };
const linked = { ...beforeMissingLink, linkExists: true };

const fixture = () => {
	const database = new DatabaseSync(":memory:");
	database.exec([
		'PRAGMA foreign_keys = ON;',
		'CREATE TABLE "oauthClient" ("id" TEXT PRIMARY KEY, "clientId" TEXT UNIQUE NOT NULL, "disabled" INTEGER, "name" TEXT, "createdAt" TEXT, "updatedAt" TEXT);',
		'CREATE TABLE "oauthResource" ("id" TEXT PRIMARY KEY, "identifier" TEXT UNIQUE NOT NULL, "name" TEXT, "disabled" INTEGER, "accessTokenTtl" INTEGER, "allowedScopes" TEXT, "createdAt" TEXT, "updatedAt" TEXT);',
		'CREATE TABLE "oauthClientResource" ("id" TEXT PRIMARY KEY, "clientId" TEXT NOT NULL, "resourceId" TEXT NOT NULL, "metadata" TEXT, "createdAt" TEXT, UNIQUE ("clientId", "resourceId"), FOREIGN KEY ("clientId") REFERENCES "oauthClient" ("clientId"), FOREIGN KEY ("resourceId") REFERENCES "oauthResource" ("identifier"));',
	].join("\n"));
	const statements = [];
	const query = async (strings, ...values) => {
		const pgText = strings.join("?");
		statements.push(pgText.replace(/\s+/g, " ").trim());
		if (/^\s*SET LOCAL (lock_timeout|statement_timeout)\s*=/.test(pgText)) return [];
		// SQLite has no FOR UPDATE. BEGIN IMMEDIATE supplies its own transaction
		// behavior; this deliberately does not test PostgreSQL row locks/timeouts.
		const sqliteText = pgText.replace(/\s+FOR UPDATE\b/g, "");
		return database.prepare(sqliteText).all(...values).map((row) =>
			Object.fromEntries(Object.entries(row).map(([key, value]) => [
				key,
				["disabled", "linkExists", "inserted"].includes(key) && [0, 1].includes(value)
					? value === 1 : value,
			])),
		);
	};
	const sql = {
		begin: async (operation) => {
			database.exec("BEGIN IMMEDIATE");
			try {
				const result = await operation(query);
				database.exec("COMMIT");
				return result;
			} catch (error) {
				database.exec("ROLLBACK");
				throw error;
			}
		},
	};
	const addClient = (clientId = CLIENT, disabled = 0) =>
		database.prepare('INSERT INTO "oauthClient" ("id", "clientId", "disabled", "name", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)')
			.run("row:" + clientId, clientId, disabled, "operator client", "2000-01-01", "2000-01-02");
	const addResource = (identifier = RESOURCE, disabled = 0) =>
		database.prepare('INSERT INTO "oauthResource" ("id", "identifier", "name", "disabled", "accessTokenTtl", "allowedScopes", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
			.run("operator-row:" + identifier, identifier, "operator resource", disabled, 120, '["openid","profile"]', "2000-01-01", "2000-01-02");
	const addLink = (id, clientId = CLIENT, resourceId = RESOURCE) =>
		database.prepare('INSERT INTO "oauthClientResource" ("id", "clientId", "resourceId", "metadata", "createdAt") VALUES (?, ?, ?, ?, ?)')
			.run(id, clientId, resourceId, '{"managed":"operator"}', "2000-01-01");
	const snapshot = () => JSON.stringify({
		clients: database.prepare('SELECT * FROM "oauthClient" ORDER BY "id"').all(),
		resources: database.prepare('SELECT * FROM "oauthResource" ORDER BY "id"').all(),
		links: database.prepare('SELECT * FROM "oauthClientResource" ORDER BY "id"').all(),
	});
	const policies = () => JSON.stringify({
		clients: database.prepare('SELECT * FROM "oauthClient" ORDER BY "id"').all(),
		resources: database.prepare('SELECT * FROM "oauthResource" ORDER BY "id"').all(),
	});
	return { database, sql, statements, addClient, addResource, addLink, snapshot, policies };
};

test("repairs exactly the Root-observed missing link and returns only booleans", async () => {
	const f = fixture();
	try {
		f.addClient(); f.addResource();
		const policyBefore = f.policies();
		const result = await repairCinatokenClientLink(f.sql);
		assert.deepEqual(result, { before: beforeMissingLink, after: linked, insertedLink: true });
		assert.equal(f.policies(), policyBefore);
		assert.deepEqual(Object.keys(result), ["before", "after", "insertedLink"]);
		for (const state of [result.before, result.after]) {
			assert.equal(Object.keys(state).length, 5);
			assert.ok(Object.values(state).every(value => typeof value === "boolean"));
		}
		const inserts = f.statements.filter(s => s.startsWith("INSERT"));
		assert.equal(inserts.length, 1);
		assert.ok(inserts[0].startsWith('INSERT INTO "oauthClientResource"'));
		assert.ok(f.statements.every(s => !/^(UPDATE|DELETE)/.test(s)));
		const linkedRows = f.database.prepare('SELECT "clientId", "resourceId" FROM "oauthClientResource"').all();
		assert.deepEqual(linkedRows.map(row => ({...row})), [{clientId: CLIENT, resourceId: RESOURCE}]);
	} finally { f.database.close(); }
});

test("replay is idempotent and leaves createdAt and all metadata intact", async () => {
	const f = fixture();
	try {
		f.addClient(); f.addResource();
		await repairCinatokenClientLink(f.sql);
		const prior = f.snapshot();
		assert.deepEqual(await repairCinatokenClientLink(f.sql), { before: linked, after: linked, insertedLink: false });
		assert.equal(f.snapshot(), prior);
	} finally { f.database.close(); }
});

test("missing resource refuses without creating a resource", async () => {
	const f = fixture();
	try {
		f.addClient(); const prior = f.snapshot();
		await assert.rejects(repairCinatokenClientLink(f.sql), /FIRSTPARTY_RESOURCE_MISSING/);
		assert.equal(f.snapshot(), prior);
		assert.equal(f.statements.filter(s => s.startsWith("INSERT")).length, 0);
	} finally { f.database.close(); }
});

test("missing client refuses without creating a client", async () => {
	const f = fixture();
	try {
		f.addResource(); const prior = f.snapshot();
		await assert.rejects(repairCinatokenClientLink(f.sql), /FIRSTPARTY_CLIENT_MISSING/);
		assert.equal(f.snapshot(), prior);
		assert.equal(f.statements.filter(s => s.startsWith("INSERT")).length, 0);
	} finally { f.database.close(); }
});

test("disabled client refuses and preserves every row", async () => {
	const f = fixture();
	try {
		f.addClient(CLIENT, 1); f.addResource(); const prior = f.snapshot();
		await assert.rejects(repairCinatokenClientLink(f.sql), /FIRSTPARTY_CLIENT_DISABLED/);
		assert.equal(f.snapshot(), prior);
		assert.equal(f.statements.filter(s => s.startsWith("INSERT")).length, 0);
	} finally { f.database.close(); }
});

test("disabled resource refuses even when its exact link already exists", async () => {
	const f = fixture();
	try {
		f.addClient(); f.addResource(RESOURCE, 1); f.addLink("operator-link"); const prior = f.snapshot();
		await assert.rejects(repairCinatokenClientLink(f.sql), /FIRSTPARTY_RESOURCE_DISABLED/);
		assert.equal(f.snapshot(), prior);
		assert.equal(f.statements.filter(s => s.startsWith("INSERT")).length, 0);
	} finally { f.database.close(); }
});

test("other clients and unrelated disabled resources never gain a link or policy changes", async () => {
	const f = fixture();
	try {
		f.addClient(); f.addResource();
		f.addClient("other-client"); f.addResource("https://unregistered.example.invalid", 1);
		f.addLink("other-operator-link", "other-client", "https://unregistered.example.invalid");
		const policyBefore = f.policies();
		const otherLinkBefore = JSON.stringify(f.database.prepare('SELECT * FROM "oauthClientResource" WHERE "clientId" = ?').all("other-client"));
		await repairCinatokenClientLink(f.sql);
		assert.equal(f.policies(), policyBefore);
		assert.equal(JSON.stringify(f.database.prepare('SELECT * FROM "oauthClientResource" WHERE "clientId" = ?').all("other-client")), otherLinkBefore);
		assert.equal(f.database.prepare('SELECT count(*) AS n FROM "oauthClientResource"').get().n, 2);
	} finally { f.database.close(); }
});

test("a reserved link ID collision never rewrites another pair and rolls back", async () => {
	const f = fixture();
	try {
		f.addClient(); f.addResource();
		f.addClient("other-client"); f.addResource("https://unregistered.example.invalid");
		f.addLink("cinatoken-admin:https://cinatoken.com", "other-client", "https://unregistered.example.invalid");
		const prior = f.snapshot();
		await assert.rejects(repairCinatokenClientLink(f.sql), /FIRSTPARTY_EXACT_ASSOCIATION_MISSING/);
		assert.equal(f.snapshot(), prior);
	} finally { f.database.close(); }
});

test("nullable disabled fields use the provider default without changing stored policy", async () => {
	const f = fixture();
	try {
		f.addClient(CLIENT, null); f.addResource(RESOURCE, null);
		const prior = f.policies();
		assert.deepEqual(await repairCinatokenClientLink(f.sql), { before: beforeMissingLink, after: linked, insertedLink: true });
		assert.equal(f.policies(), prior);
	} finally { f.database.close(); }
});

