import type {
	GatewayRepositories,
	ConfigGroupApplyInput,
	ConfigGroupApplyResult,
	ConfigGroupAuditRow,
	ConfigRevisionVector,
	ConfigSnapshot,
} from "@octafuse/core";
import { hasAdminPermission, type AdminPrincipal } from "@/lib/admin-principal";
import {
	ToolConfigError,
	TOOL_CONFIG_FAMILIES,
	TOOL_CONFIG_PROVIDERS,
	TOOL_CONFIG_BOUNDS,
	type ToolConfigFamily,
	type ToolConfigProvider,
	type ToolConfigSaveBody,
	type ToolConfigSaveResult,
	type ToolConfigRevealBody,
	type ToolConfigRevealResult,
	type ToolConfigAuditEntry,
	type ToolConfigAuditResult,
	type ToolConfigOverview,
	type ToolConfigOp,
} from "./tool-config-contract";
import {
	TOOL_CONFIG_KEYS,
	TOOL_CONFIG_OVERVIEW_KEYS,
	TOOL_CONFIG_UUID,
	TOOL_CONFIG_CONTROLS,
	assertToolConfigVector,
	parseToolConfigVersion,
	toolConfigVersion,
	toolConfigFields,
	toolConfigCursor,
	toolConfigInstant,
	toolConfigReason,
	toolConfigJson,
} from "./tool-config-input";
import {
	prepareToolConfigFamily,
	toolConfigCapabilities,
	toolConfigDetail,
	toolConfigProviderSummary,
	toolConfigCatalogKey,
	toolConfigActiveKey,
	toolConfigEntryPrices,
	toolConfigSecrets,
	redactToolConfigText,
	toolConfigSnapshotSecrets,
	type ToolConfigPrepared,
	type ToolConfigEntry,
} from "./tool-config-dto";

function forbidden(): never {
	throw new ToolConfigError(403, "tools_forbidden", "Forbidden");
}
function conflict(): never {
	throw new ToolConfigError(
		409,
		"tools_version_conflict",
		"Tools configuration changed; reload and review again"
	);
}
function unavailable(): never {
	throw new ToolConfigError(
		503,
		"tools_repository_unavailable",
		"Atomic Tools configuration storage is unavailable"
	);
}
function requirePermission(
	principal: AdminPrincipal,
	permission: "config.read" | "config.write" | "config.secrets.read"
): void {
	if (!hasAdminPermission(principal, permission)) forbidden();
}
function actor(principal: AdminPrincipal) {
	const console = principal.type === "console";
	if (
		typeof principal.id !== "string" ||
		!principal.id ||
		[...principal.id].length > (console ? 617 : 600) ||
		TOOL_CONFIG_CONTROLS.test(principal.id) ||
		principal.id !==
			(console
				? "console:" + principal.username
				: "admin_key:" + principal.keyId)
	)
		forbidden();
	return {
		actorKind: console ? ("console" as const) : ("admin_key" as const),
		actorId: principal.id,
	};
}
function repository(repos: GatewayRepositories) {
	const store = repos.systemConfig;
	if (
		typeof store.getConfigSnapshots !== "function" ||
		typeof store.applyConfigGroupIfRevisions !== "function" ||
		typeof store.listConfigGroupAudit !== "function"
	)
		unavailable();
	return store;
}
async function snapshots(
	repos: GatewayRepositories,
	keys: readonly string[]
): Promise<ConfigSnapshot[]> {
	const rows = await repository(repos).getConfigSnapshots([...keys]);
	if (
		!Array.isArray(rows) ||
		rows.length !== keys.length ||
		rows.some(
			(row, index) =>
				row?.key !== keys[index] ||
				(row.value !== null && typeof row.value !== "string") ||
				!(
					row.revision === null ||
					row.revision === "legacy" ||
					(typeof row.revision === "string" &&
						TOOL_CONFIG_UUID.test(row.revision))
				) ||
				(row.revision === null && row.value !== null)
		)
	)
		unavailable();
	return rows;
}
function equalVector(left: ConfigRevisionVector, right: ConfigRevisionVector) {
	return (
		left.length === right.length &&
		left.every(
			(row, index) =>
				row.key === right[index]?.key && row.revision === right[index]?.revision
		)
	);
}
function editable(prepared: ToolConfigPrepared): void {
	if (!prepared.state.editable)
		throw new ToolConfigError(
			409,
			prepared.state.editBlockedCode ?? "invalid_source",
			"Tools source cannot be safely edited"
		);
}
export async function getToolConfigOverview(
	repos: GatewayRepositories,
	principal: AdminPrincipal
): Promise<ToolConfigOverview> {
	requirePermission(principal, "config.read");
	const all = await snapshots(repos, TOOL_CONFIG_OVERVIEW_KEYS);
	const families = TOOL_CONFIG_FAMILIES.map((family) => {
		const prepared = prepareToolConfigFamily(family, all);
		return {
			...prepared.state,
			providers: TOOL_CONFIG_PROVIDERS[family].map((provider) =>
				toolConfigProviderSummary(prepared, provider)
			),
		};
	});
	return {
		billingCurrency: prepareToolConfigFamily("web-search", all).currency,
		families,
		capabilities: toolConfigCapabilities(principal),
	};
}
export async function getToolConfigProviderDetail(
	repos: GatewayRepositories,
	principal: AdminPrincipal,
	family: ToolConfigFamily,
	provider: ToolConfigProvider
) {
	requirePermission(principal, "config.read");
	const prepared = prepareToolConfigFamily(
		family,
		await snapshots(repos, TOOL_CONFIG_KEYS[family])
	);
	return toolConfigDetail(prepared, provider, principal);
}
function migrateCatalog(
	prepared: ToolConfigPrepared
): Record<string, ToolConfigEntry> {
	const catalog = structuredClone(prepared.catalog);
	if (
		prepared.state.catalogState === "missing" &&
		prepared.legacyProvider &&
		prepared.legacyPrice
	) {
		catalog[prepared.legacyProvider] = {
			apiKey: prepared.legacyKey,
			...prepared.legacyPrice,
			cost: prepared.legacyPrice.charged,
		};
	}
	return catalog;
}
function effectiveValue(
	entry: ToolConfigEntry | undefined,
	field: string
): string {
	return typeof entry?.[field] === "string"
		? (entry[field] as string).trim()
		: "";
}
function applyOp(
	entry: ToolConfigEntry,
	field: string,
	op: ToolConfigOp
): boolean {
	if (op.op === "keep") return false;
	const value = op.op === "clear" ? "" : op.value;
	if (effectiveValue(entry, field) === value) return false;
	entry[field] = value;
	return true;
}
function postPrepared(
	before: ToolConfigPrepared,
	writes: ConfigGroupApplyInput["writes"],
	vector: ConfigRevisionVector
): ToolConfigPrepared {
	assertToolConfigVector(before.family, vector);
	const prepared = prepareToolConfigFamily(
		before.family,
		before.snapshots.map((row) => ({
			...row,
			value: writes.find((write) => write.key === row.key)?.value ?? row.value,
			revision: vector.find((next) => next.key === row.key)!.revision,
		}))
	);
	prepared.secrets = [
		...new Set([
			...before.secrets,
			...prepared.secrets,
			...toolConfigSnapshotSecrets(prepared.snapshots),
		]),
	];
	return prepared;
}
function preserveSelection(
	before: ToolConfigPrepared,
	after: ToolConfigPrepared
): void {
	if (
		before.state.effectiveProvider !== after.state.effectiveProvider ||
		before.state.configurationReady !== after.state.configurationReady
	)
		throw new ToolConfigError(
			409,
			"tools_activation_required",
			"Use save and activate to change the effective provider or readiness"
		);
}
function lossPricing(
	before: ToolConfigPrepared,
	after: ToolConfigPrepared,
	accept: boolean,
	changed: boolean
) {
	if (!changed || accept) return;
	for (const provider of TOOL_CONFIG_PROVIDERS[before.family]) {
		const previous = toolConfigProviderSummary(before, provider).prices;
		const current = toolConfigProviderSummary(after, provider).prices;
		if (
			current &&
			current.charged < current.metered &&
			JSON.stringify(current) !== JSON.stringify(previous)
		)
			throw new ToolConfigError(
				409,
				"tools_loss_pricing_confirmation_required",
				"Confirm pricing below metered cost"
			);
		if (
			current &&
			current.charged < current.metered &&
			after.state.effectiveProvider === provider &&
			after.state.configurationReady &&
			(before.state.effectiveProvider !== provider ||
				!before.state.configurationReady)
		)
			throw new ToolConfigError(
				409,
				"tools_loss_pricing_confirmation_required",
				"Confirm pricing below metered cost"
			);
	}
}
async function apply(
	repos: GatewayRepositories,
	input: ConfigGroupApplyInput
): Promise<ConfigGroupApplyResult> {
	const result = await repository(repos).applyConfigGroupIfRevisions(input);
	if (!result || !["applied", "unchanged", "conflict"].includes(result.outcome))
		unavailable();
	try {
		assertToolConfigVector(input.family, result.revisionVector);
	} catch {
		unavailable();
	}
	if (result.outcome === "conflict") conflict();
	if (
		result.outcome === "applied"
			? result.auditId !== input.safeAudit.auditId ||
			  !TOOL_CONFIG_UUID.test(result.auditId)
			: result.auditId !== null
	)
		unavailable();
	for (const row of result.revisionVector) {
		const previous = input.readSet.find((value) => value.key === row.key)!;
		const written = input.writes.some((write) => write.key === row.key);
		if (result.outcome === "unchanged" || !written) {
			if (row.revision !== previous.revision) unavailable();
		} else if (
			row.revision === previous.revision ||
			!row.revision ||
			!TOOL_CONFIG_UUID.test(row.revision)
		)
			unavailable();
	}
	return result;
}
export async function saveToolConfig(
	repos: GatewayRepositories,
	principal: AdminPrincipal,
	family: ToolConfigFamily,
	provider: ToolConfigProvider,
	body: ToolConfigSaveBody
): Promise<ToolConfigSaveResult> {
	requirePermission(principal, "config.write");
	const trusted = actor(principal);
	const readSet = parseToolConfigVersion(family, body.expected_version);
	const all = await snapshots(repos, TOOL_CONFIG_OVERVIEW_KEYS);
	const prepared = prepareToolConfigFamily(family, all);
	prepared.secrets = toolConfigSnapshotSecrets(all);
	if (!equalVector(readSet, prepared.vector)) conflict();
	editable(prepared);
	const catalog = migrateCatalog(prepared);
	const entryKey = prepared.entryKeys[provider] ?? provider;
	const original = catalog[entryKey];
	const entry: ToolConfigEntry = {
		...(original ?? (family === "ai-detection" ? {} : { apiKey: "" })),
	};
	const changedFields: ConfigGroupApplyInput["safeAudit"]["changedFields"][number][] =
		[];
	const oldPrices = toolConfigEntryPrices(entry, family);
	for (const field of ["metered", "standard", "charged"] as const)
		if (oldPrices[field] !== body.prices[field] || !original) {
			entry[field] = body.prices[field];
			changedFields.push({ provider, field });
		}
	if (entry.charged !== undefined) entry.cost = body.prices.charged;
	const credentials: ConfigGroupApplyInput["safeAudit"]["credentials"][number][] =
		[];
	for (const field of toolConfigFields(family)) {
		const op = body.credentials[field]!;
		const changed = applyOp(entry, field, op);
		if (changed) changedFields.push({ provider, field });
		credentials.push({
			provider,
			field,
			operation: op.op,
			configuredBefore: !!effectiveValue(original, field),
			configuredAfter: !!effectiveValue(entry, field),
		});
	}
	for (const field of ["region", "bizType"] as const)
		if (body.settings?.[field] && applyOp(entry, field, body.settings[field]))
			changedFields.push({ provider, field });
	if (
		body.settings?.billingUnitChars !== undefined &&
		Number(entry.billingUnitChars ?? 2000) !== body.settings.billingUnitChars
	) {
		entry.billingUnitChars = body.settings.billingUnitChars;
		changedFields.push({ provider, field: "billingUnitChars" });
	}
	catalog[entryKey] = entry;
	const rawCatalog = JSON.stringify(catalog);
	if (
		new TextEncoder().encode(rawCatalog).length >
		TOOL_CONFIG_BOUNDS.catalogBytes
	)
		throw new ToolConfigError(
			400,
			"invalid_tool_config_input",
			"Tools catalog is too large"
		);
	const writes: Array<{ key: string; value: string }> = [];
	const oldCatalog = prepared.snapshots.find(
		(row) => row.key === toolConfigCatalogKey(family)
	)?.value;
	if (
		!original ||
		changedFields.length ||
		prepared.state.catalogState === "missing"
	)
		writes.push({ key: toolConfigCatalogKey(family), value: rawCatalog });
	// A legacy migration retains its effective provider, even when stale ACTIVE was ignored.
	const nextActive =
		body.operation === "save_activate"
			? provider
			: prepared.state.catalogState === "missing" && prepared.legacyProvider
			? prepared.legacyProvider
			: null;
	if (
		nextActive !== null &&
		prepared.snapshots.find((row) => row.key === toolConfigActiveKey(family))
			?.value !== nextActive
	) {
		writes.push({ key: toolConfigActiveKey(family), value: nextActive });
		changedFields.push({ provider: null, field: "active" });
	}
	if (prepared.state.catalogState === "missing")
		changedFields.push({ provider: null, field: "legacy_migration" });
	if (
		oldCatalog === rawCatalog &&
		writes.some((write) => write.key === toolConfigCatalogKey(family))
	)
		writes.splice(
			writes.findIndex((write) => write.key === toolConfigCatalogKey(family)),
			1
		);
	const after = postPrepared(prepared, writes, prepared.vector);
	if (body.operation === "save") preserveSelection(prepared, after);
	else if (
		after.state.effectiveProvider !== provider ||
		!after.state.configurationReady
	)
		throw new ToolConfigError(
			409,
			"tools_provider_not_ready",
			"The selected provider requires valid credentials and pricing"
		);
	lossPricing(prepared, after, body.accept_loss_pricing, writes.length > 0);
	const secrets = [...prepared.secrets, ...toolConfigSecrets(catalog)];
	const result = await apply(repos, {
		family,
		readSet,
		writes,
		safeAudit: {
			...trusted,
			auditId: crypto.randomUUID(),
			action: body.operation,
			provider,
			source: "admin_api",
			nowIso: new Date().toISOString(),
			reason: redactToolConfigText(toolConfigReason(body.reason), secrets),
			changedFields,
			activeBefore: prepared.state.effectiveProvider,
			activeAfter: after.state.effectiveProvider,
			credentials,
		},
	});
	return {
		outcome: result.outcome as "applied" | "unchanged",
		auditId: result.auditId,
		detail: toolConfigDetail(
			postPrepared(prepared, writes, result.revisionVector),
			provider,
			principal
		),
	};
}
export async function revealToolConfig(
	repos: GatewayRepositories,
	principal: AdminPrincipal,
	family: ToolConfigFamily,
	provider: ToolConfigProvider,
	body: ToolConfigRevealBody
): Promise<ToolConfigRevealResult> {
	requirePermission(principal, "config.read");
	requirePermission(principal, "config.secrets.read");
	const trusted = actor(principal);
	const readSet = parseToolConfigVersion(family, body.expected_version);
	const all = await snapshots(repos, TOOL_CONFIG_OVERVIEW_KEYS);
	const prepared = prepareToolConfigFamily(family, all);
	prepared.secrets = toolConfigSnapshotSecrets(all);
	if (!equalVector(readSet, prepared.vector)) conflict();
	if (
		prepared.state.editBlockedCode === "invalid_source" ||
		prepared.state.editBlockedCode === "unsupported_source"
	)
		throw new ToolConfigError(
			409,
			"invalid_source",
			"Tools source cannot be safely revealed"
		);
	const legacy =
		prepared.state.catalogState === "missing" &&
		prepared.legacyProvider === provider;
	const entry = prepared.catalog[prepared.entryKeys[provider] ?? ""];
	const value =
		legacy && body.field === "apiKey"
			? prepared.legacyKey
			: effectiveValue(entry, body.field);
	if (
		!value ||
		value.length > TOOL_CONFIG_BOUNDS.credential ||
		TOOL_CONFIG_CONTROLS.test(value)
	)
		throw new ToolConfigError(
			404,
			"tools_credential_not_configured",
			"The requested credential is not configured"
		);
	const result = await apply(repos, {
		family,
		readSet,
		writes: [],
		safeAudit: {
			...trusted,
			auditId: crypto.randomUUID(),
			action: "reveal",
			provider,
			source: "admin_api",
			nowIso: new Date().toISOString(),
			reason: redactToolConfigText(
				toolConfigReason(body.reason),
				prepared.secrets
			),
			changedFields: [],
			activeBefore: prepared.state.effectiveProvider,
			activeAfter: prepared.state.effectiveProvider,
			credentials: [
				{
					provider,
					field: body.field,
					operation: "reveal",
					configuredBefore: true,
					configuredAfter: true,
				},
			],
		},
	});
	if (
		result.outcome !== "applied" ||
		!result.auditId ||
		!equalVector(result.revisionVector, readSet)
	)
		unavailable();
	return {
		family,
		provider,
		field: body.field,
		value,
		version: body.expected_version,
		auditId: result.auditId,
		expiresInSeconds: 60,
	};
}
function auditEntry(
	row: ConfigGroupAuditRow,
	family: ToolConfigFamily,
	secrets: readonly string[]
): ToolConfigAuditEntry {
	if (
		row.family !== family ||
		!TOOL_CONFIG_UUID.test(row.id) ||
		!["console", "admin_key"].includes(row.actorKind) ||
		typeof row.actorId !== "string" ||
		!row.actorId ||
		[...row.actorId].length > (row.actorKind === "console" ? 617 : 600) ||
		TOOL_CONFIG_CONTROLS.test(row.actorId) ||
		typeof row.reason !== "string" ||
		!row.reason.trim() ||
		Array.from(row.reason).length > TOOL_CONFIG_BOUNDS.reason ||
		TOOL_CONFIG_CONTROLS.test(row.reason)
	)
		unavailable();
	const providers: readonly string[] = TOOL_CONFIG_PROVIDERS[family];
	const fields = [
		"catalog",
		"active",
		"legacy_migration",
		"metered",
		"standard",
		"charged",
		"billingUnitChars",
		"region",
		"bizType",
		"apiKey",
		"secretId",
		"secretKey",
		"email",
	];
	if (
		!["save", "save_activate", "activate", "legacy_save", "reveal"].includes(
			row.action
		) ||
		!["admin_api", "legacy_admin"].includes(row.source) ||
		(row.provider !== null && !providers.includes(row.provider)) ||
		(row.provider === null && row.action !== "legacy_save") ||
		(row.activeBefore !== null && !providers.includes(row.activeBefore)) ||
		(row.activeAfter !== null && !providers.includes(row.activeAfter)) ||
		!Array.isArray(row.changedFields) ||
		row.changedFields.length > 59 ||
		!Array.isArray(row.credentials) ||
		row.credentials.length > providers.length * 4
	)
		unavailable();
	const changedFields = row.changedFields.map((value) => {
		if (
			!fields.includes(value.field) ||
			(value.provider === null
				? !["catalog", "active", "legacy_migration"].includes(value.field)
				: !providers.includes(value.provider))
		)
			unavailable();
		return { provider: value.provider, field: value.field };
	});
	const credentials = row.credentials.map((value) => {
		if (
			!providers.includes(value.provider) ||
			!["apiKey", "secretId", "secretKey", "email"].includes(value.field) ||
			!["keep", "set", "clear", "reveal"].includes(value.operation) ||
			typeof value.configuredBefore !== "boolean" ||
			typeof value.configuredAfter !== "boolean"
		)
			unavailable();
		return {
			provider: value.provider,
			field: value.field,
			operation: value.operation,
			configuredBefore: value.configuredBefore,
			configuredAfter: value.configuredAfter,
		};
	});
	if (
		new Set(changedFields.map((value) => value.provider + ":" + value.field))
			.size !== changedFields.length ||
		new Set(credentials.map((value) => value.provider + ":" + value.field))
			.size !== credentials.length ||
		(row.action === "reveal"
			? credentials.length !== 1 || credentials[0].operation !== "reveal"
			: credentials.some((value) => value.operation === "reveal"))
	)
		unavailable();
	return {
		id: row.id,
		family,
		provider: row.provider,
		action: row.action,
		actorKind: row.actorKind,
		actorId: redactToolConfigText(
			row.actorId,
			secrets,
			row.actorKind === "console" ? 617 : 600
		),
		source: row.source,
		reason: redactToolConfigText(row.reason, secrets),
		changedFields,
		activeBefore: row.activeBefore,
		activeAfter: row.activeAfter,
		credentials,
		beforeVersion: toolConfigVersion(family, row.revisionBefore),
		afterVersion: toolConfigVersion(family, row.revisionAfter),
		createdAt: toolConfigInstant(row.createdAt),
	};
}
export async function getToolConfigAudit(
	repos: GatewayRepositories,
	principal: AdminPrincipal,
	family: ToolConfigFamily,
	options: { limit: number; before?: { createdAt: string; id: string } }
): Promise<ToolConfigAuditResult> {
	requirePermission(principal, "config.read");
	const snapshotRows = await snapshots(repos, TOOL_CONFIG_OVERVIEW_KEYS);
	const prepared = prepareToolConfigFamily(family, snapshotRows);
	prepared.secrets = toolConfigSnapshotSecrets(snapshotRows);
	const rows = await repository(repos).listConfigGroupAudit(family, {
		...options,
		limit: options.limit + 1,
	});
	if (!Array.isArray(rows) || rows.length > options.limit + 1) unavailable();
	const all = rows.map((row) => auditEntry(row, family, prepared.secrets));
	for (let index = 0; index < all.length; index++) {
		const current = all[index];
		const previous = index === 0 ? options.before : all[index - 1];
		if (
			previous &&
			!(
				current.createdAt < previous.createdAt ||
				(current.createdAt === previous.createdAt && current.id < previous.id)
			)
		)
			unavailable();
	}
	const entries = all.slice(0, options.limit);
	const last = entries.at(-1);
	return {
		entries,
		next_cursor:
			all.length > options.limit && last
				? toolConfigCursor(family, last)
				: null,
	};
}

export function toolConfigGenericFamily(key: string): ToolConfigFamily | null {
	return (
		TOOL_CONFIG_FAMILIES.find(
			(family) =>
				key === toolConfigCatalogKey(family) ||
				key === toolConfigActiveKey(family)
		) ?? null
	);
}
export async function updateGenericToolConfig(
	repos: GatewayRepositories,
	principal: AdminPrincipal,
	input: {
		key: string;
		value: string;
		tools_version?: unknown;
		reason?: unknown;
		accept_loss_pricing?: unknown;
	},
	options: { requireVersion?: boolean; expectedRevision?: string | null } = {}
): Promise<{ committed: boolean; revision: string | null }> {
	requirePermission(principal, "config.write");
	const trusted = actor(principal);
	const family = toolConfigGenericFamily(input.key);
	if (!family)
		throw new ToolConfigError(
			400,
			"invalid_tool_config_input",
			"Invalid Tools config key"
		);
	if (input.key === toolConfigCatalogKey(family))
		toolConfigJson(input.value, TOOL_CONFIG_BOUNDS.catalogBytes);
	else if (
		!(TOOL_CONFIG_PROVIDERS[family] as readonly string[]).includes(
			input.value.trim().toLowerCase()
		)
	)
		throw new ToolConfigError(
			400,
			"invalid_tool_config_input",
			"Invalid Tools active provider"
		);
	const explicit = input.tools_version !== undefined;
	if (!explicit && options.requireVersion)
		throw new ToolConfigError(
			428,
			"tools_version_required",
			"A complete Tools version is required"
		);
	const expected = explicit
		? parseToolConfigVersion(family, input.tools_version)
		: null;
	const reason = explicit
		? toolConfigReason(input.reason)
		: "Legacy Admin generic Tools write using a fresh server read set";
	if (
		input.accept_loss_pricing !== undefined &&
		typeof input.accept_loss_pricing !== "boolean"
	)
		throw new ToolConfigError(
			400,
			"invalid_tool_config_input",
			"Invalid loss pricing confirmation"
		);
	const all = await snapshots(repos, TOOL_CONFIG_OVERVIEW_KEYS);
	const prepared = prepareToolConfigFamily(family, all);
	prepared.secrets = toolConfigSnapshotSecrets(all);
	if (expected && !equalVector(expected, prepared.vector)) conflict();
	if (
		options.expectedRevision !== undefined &&
		prepared.snapshots.find((row) => row.key === input.key)?.revision !==
			options.expectedRevision
	)
		conflict();
	editable(prepared);
	const write = { key: input.key, value: input.value };
	const after = postPrepared(prepared, [write], prepared.vector);
	if (
		after.state.editBlockedCode === "invalid_source" ||
		after.state.editBlockedCode === "unsupported_source"
	)
		throw new ToolConfigError(
			400,
			"invalid_tool_config_input",
			"Invalid Tools catalog input"
		);
	if (
		input.key === toolConfigActiveKey(family) &&
		after.state.activeState === "invalid"
	)
		throw new ToolConfigError(
			400,
			"invalid_tool_config_input",
			"Invalid Tools active provider"
		);
	editable(after);
	const catalogWrite = input.key === toolConfigCatalogKey(family);
	if (catalogWrite) preserveSelection(prepared, after);
	else if (!after.state.configurationReady)
		throw new ToolConfigError(
			409,
			"tools_provider_not_ready",
			"The selected provider requires valid credentials and pricing"
		);
	const changed =
		prepared.snapshots.find((row) => row.key === input.key)?.value !==
		input.value;
	lossPricing(prepared, after, input.accept_loss_pricing === true, changed);
	const credentials: ConfigGroupApplyInput["safeAudit"]["credentials"][number][] =
		[];
	for (const provider of TOOL_CONFIG_PROVIDERS[family])
		for (const field of ["apiKey", "secretId", "secretKey", "email"] as const) {
			const beforeEntry = prepared.catalog[prepared.entryKeys[provider] ?? ""];
			const afterEntry = after.catalog[after.entryKeys[provider] ?? ""];
			const before = effectiveValue(beforeEntry, field);
			const next = effectiveValue(afterEntry, field);
			if (before !== next)
				credentials.push({
					provider,
					field,
					operation: next ? "set" : "clear",
					configuredBefore: !!before,
					configuredAfter: !!next,
				});
		}
	const result = await apply(repos, {
		family,
		readSet: expected ?? prepared.vector,
		writes: changed ? [write] : [],
		safeAudit: {
			...trusted,
			auditId: crypto.randomUUID(),
			nowIso: new Date().toISOString(),
			action: catalogWrite ? "legacy_save" : "activate",
			provider: catalogWrite ? null : after.state.effectiveProvider,
			source: explicit ? "admin_api" : "legacy_admin",
			reason: redactToolConfigText(reason, [
				...prepared.secrets,
				...after.secrets,
				...toolConfigSecrets(after.catalog),
			]),
			changedFields: changed
				? [
						{ provider: null, field: catalogWrite ? "catalog" : "active" },
						...credentials.map((row) => ({
							provider: row.provider,
							field: row.field,
						})),
				  ]
				: [],
			activeBefore: prepared.state.effectiveProvider,
			activeAfter: after.state.effectiveProvider,
			credentials,
		},
	});
	return {
		committed: true,
		revision: result.revisionVector.find((row) => row.key === input.key)!
			.revision,
	};
}
