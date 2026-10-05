import type { AdminPrincipal } from "@/lib/admin-principal";
import {
	CinaAuthConsoleVerificationUnavailableError,
	cinaAuthSubjectFromPrincipal,
	verifyCinaAuthConsolePrincipal,
} from "@/lib/cinaauth/principal";

type AdminAuthCheck =
	| { authenticated: false; verification: "none" | "rejected" }
	| {
			authenticated: true;
			principalType: AdminPrincipal["type"];
			verification: "degraded";
	  }
	| { authenticated: true; principalType: "api_key"; verification: "verified" }
	| {
			authenticated: true;
			principalType: "console";
			verification: "verified";
			subject: string;
	  };

function response(check: AdminAuthCheck): Response {
	return Response.json(check, { headers: { "Cache-Control": "no-store" } });
}

/** Only a live, role-verified console response proves its authenticated CinaAuth subject. */
export async function createAdminAuthCheckResponse(
	request: Request,
	principal: AdminPrincipal | null,
	env?: { CINAAUTH_AUTH_SERVICE?: Fetcher }
): Promise<Response> {
	if (!principal)
		return response({ authenticated: false, verification: "none" });
	let verified: AdminPrincipal | null;
	try {
		verified = await verifyCinaAuthConsolePrincipal(request, principal, env);
	} catch (error) {
		if (!(error instanceof CinaAuthConsoleVerificationUnavailableError))
			throw error;
		// Local validity during an IdP outage proves neither current roles nor subject.
		return response({
			authenticated: true,
			principalType: principal.type,
			verification: "degraded",
		});
	}
	if (!verified)
		return response({ authenticated: false, verification: "rejected" });
	if (verified.type === "api_key") {
		return response({
			authenticated: true,
			principalType: "api_key",
			verification: "verified",
		});
	}
	// verifyCinaAuthConsolePrincipal already checked the upstream user.id against
	// this exact stored subject. Never derive it from caller query/body fields.
	const subject = cinaAuthSubjectFromPrincipal(verified);
	if (!subject)
		return response({ authenticated: false, verification: "rejected" });
	return response({
		authenticated: true,
		principalType: "console",
		verification: "verified",
		subject,
	});
}
