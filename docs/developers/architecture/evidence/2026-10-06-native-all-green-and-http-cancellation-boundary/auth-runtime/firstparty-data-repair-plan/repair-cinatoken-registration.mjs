const CLIENT_ID = "cinatoken-admin";
const RESOURCE = "https://cinatoken.com";
const RESOURCE_ROW_ID = "first-party:https://cinatoken.com";
const LINK_ROW_ID = "cinatoken-admin:https://cinatoken.com";

const readState = async (tx) => {
	const clients = await tx`
		SELECT COALESCE("disabled", FALSE) AS "disabled"
		FROM "oauthClient" WHERE "clientId" = ${CLIENT_ID} FOR UPDATE
	`;
	const resources = await tx`
		SELECT COALESCE("disabled", FALSE) AS "disabled"
		FROM "oauthResource" WHERE "identifier" = ${RESOURCE} FOR UPDATE
	`;
	const links = await tx`
		SELECT EXISTS (
			SELECT 1 FROM "oauthClientResource"
			WHERE "clientId" = ${CLIENT_ID} AND "resourceId" = ${RESOURCE}
		) AS "linkExists"
	`;
	if (clients.length > 1 || resources.length > 1 || links.length !== 1) {
		throw new Error("FIRSTPARTY_REGISTRATION_STATE_INVALID");
	}
	for (const row of [...clients, ...resources]) {
		if (typeof row.disabled !== "boolean") {
			throw new Error("FIRSTPARTY_DISABLED_STATE_INVALID");
		}
	}
	if (typeof links[0].linkExists !== "boolean") {
		throw new Error("FIRSTPARTY_LINK_STATE_INVALID");
	}
	return {
		clientExists: clients.length === 1,
		clientDisabled: clients[0]?.disabled === true,
		resourceExists: resources.length === 1,
		resourceDisabled: resources[0]?.disabled === true,
		linkExists: links[0].linkExists,
	};
};

const requireAllowed = (state) => {
	if (!state.clientExists) throw new Error("FIRSTPARTY_CLIENT_MISSING");
	if (state.clientDisabled) throw new Error("FIRSTPARTY_CLIENT_DISABLED");
	if (state.resourceDisabled) throw new Error("FIRSTPARTY_RESOURCE_DISABLED");
};

/** Fixed first-party registration repair; no caller-controlled client/resource. */
export const repairCinatokenRegistration = async (sql) =>
	sql.begin(async (tx) => {
		await tx`SET LOCAL lock_timeout = '5s'`;
		await tx`SET LOCAL statement_timeout = '10s'`;
		const before = await readState(tx);
		requireAllowed(before);
		const insertedResourceRows = await tx`
			INSERT INTO "oauthResource"
				("id", "identifier", "name", "createdAt", "updatedAt")
			VALUES (${RESOURCE_ROW_ID}, ${RESOURCE}, ${"cinatoken Gateway"}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
			ON CONFLICT ("identifier") DO NOTHING
			RETURNING TRUE AS "inserted"
		`;
		// An absent row was not lockable before insertion. Re-lock the winning
		// row and re-check after ON CONFLICT, including a concurrently created row.
		const lockedResources = await tx`
			SELECT COALESCE("disabled", FALSE) AS "disabled"
			FROM "oauthResource" WHERE "identifier" = ${RESOURCE} FOR UPDATE
		`;
		if (lockedResources.length !== 1) throw new Error("FIRSTPARTY_RESOURCE_MISSING");
		if (typeof lockedResources[0].disabled !== "boolean") {
			throw new Error("FIRSTPARTY_DISABLED_STATE_INVALID");
		}
		if (lockedResources[0].disabled) throw new Error("FIRSTPARTY_RESOURCE_DISABLED");
		const insertedLinkRows = await tx`
			INSERT INTO "oauthClientResource"
				("id", "clientId", "resourceId", "createdAt")
			VALUES (${LINK_ROW_ID}, ${CLIENT_ID}, ${RESOURCE}, CURRENT_TIMESTAMP)
			ON CONFLICT DO NOTHING
			RETURNING TRUE AS "inserted"
		`;
		const after = await readState(tx);
		requireAllowed(after);
		if (!after.resourceExists || !after.linkExists) {
			throw new Error("FIRSTPARTY_EXACT_ASSOCIATION_MISSING");
		}
		return {
			before,
			after,
			insertedResource: insertedResourceRows.length === 1,
			insertedClientLink: insertedLinkRows.length === 1,
		};
	});

