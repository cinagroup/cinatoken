import type { Context } from "hono";
import type { AdminEnv } from "@/lib/admin-env";

export type ConfigRevisionPrecondition =
	| { kind: "match"; revision: string }
	| { kind: "missing-row" }
	| { kind: "absent" }
	| { kind: "invalid" };

// Rows predating the revision migration start at this opaque, non-secret token.
const QUOTED_REVISION =
	/^"(legacy|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"$/iu;

/** An opaque row revision, never the configuration value or a value-derived hash. */
export function parseConfigRevisionPrecondition(headers: {
	ifMatch?: string;
	ifNoneMatch?: string;
}): ConfigRevisionPrecondition {
	const match = headers.ifMatch?.trim();
	const none = headers.ifNoneMatch?.trim();
	const hasMatch = headers.ifMatch !== undefined;
	const hasNone = headers.ifNoneMatch !== undefined;
	if (!hasMatch && !hasNone) return { kind: "absent" };
	if (hasMatch && hasNone) return { kind: "invalid" };
	if (hasNone)
		return none === "*" ? { kind: "missing-row" } : { kind: "invalid" };
	const parsed = QUOTED_REVISION.exec(match ?? "");
	return parsed
		? { kind: "match", revision: parsed[1]!.toLowerCase() }
		: { kind: "invalid" };
}

export function configRevisionPrecondition(
	c: Context<AdminEnv>
): ConfigRevisionPrecondition {
	return parseConfigRevisionPrecondition({
		ifMatch: c.req.header("If-Match"),
		ifNoneMatch: c.req.header("If-None-Match"),
	});
}

export function configRevisionError(
	c: Context<AdminEnv>,
	kind: "absent" | "invalid"
) {
	return kind === "absent"
		? c.json(
				{
					success: false,
					code: "config_precondition_required",
					message: "Configuration revision required",
				},
				428
		  )
		: c.json(
				{
					success: false,
					code: "config_precondition_invalid",
					message: "Invalid configuration revision",
				},
				400
		  );
}

export function configRevisionConflict(c: Context<AdminEnv>) {
	return c.json(
		{
			success: false,
			code: "config_revision_conflict",
			message: "Configuration changed; refresh before retrying",
		},
		412
	);
}
