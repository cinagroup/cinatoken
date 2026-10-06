const CLIENT_ID = "cinatoken-admin";
const RESOURCE = "https://cinatoken.com";
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
	if (!state.resourceExists) throw new Error("FIRSTPARTY_RESOURCE_MISSING");
	if (state.resourceDisabled) throw new Error("FIRSTPARTY_RESOURCE_DISABLED");
};

/** Repair only the confirmed missing fixed-client link; never write resource policy. */
export const repairCinatokenClientLink = async (sql) =>
	sql.begin(async (tx) => {
		await tx`SET LOCAL lock_timeout = '5s'`;
		await tx`SET LOCAL statement_timeout = '10s'`;
		const before = await readState(tx);
		requireAllowed(before);
		const inserted = await tx`
			INSERT INTO "oauthClientResource"
				("id", "clientId", "resourceId", "createdAt")
			VALUES (${LINK_ROW_ID}, ${CLIENT_ID}, ${RESOURCE}, CURRENT_TIMESTAMP)
			ON CONFLICT DO NOTHING
			RETURNING TRUE AS "inserted"
		`;
		const after = await readState(tx);
		requireAllowed(after);
		if (!after.linkExists) throw new Error("FIRSTPARTY_EXACT_ASSOCIATION_MISSING");
		return { before, after, insertedLink: inserted.length === 1 };
	});

