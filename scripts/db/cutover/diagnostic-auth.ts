const MINIMUM_DIAGNOSTIC_TOKEN_LENGTH = 32;

async function sha256(value: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

export async function isDiagnosticRequestAuthorized(
	request: Request,
	expectedToken: string | undefined,
): Promise<boolean> {
	if (!expectedToken || expectedToken.length < MINIMUM_DIAGNOSTIC_TOKEN_LENGTH) return false;
	const authorization = request.headers.get('Authorization');
	if (!authorization?.startsWith('Bearer ')) return false;
	const suppliedToken = authorization.slice('Bearer '.length);
	if (!suppliedToken) return false;

	const [expectedDigest, suppliedDigest] = await Promise.all([
		sha256(expectedToken),
		sha256(suppliedToken),
	]);
	let difference = 0;
	for (let index = 0; index < expectedDigest.length; index += 1) {
		difference |= expectedDigest[index]! ^ suppliedDigest[index]!;
	}
	return difference === 0;
}
