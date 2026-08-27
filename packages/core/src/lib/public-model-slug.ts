const SAFE_PUBLIC_MODEL_SLUG = /^[A-Za-z0-9._:-]+$/;

/**
 * Stable, URL-segment-safe model identifier for the public product layer.
 *
 * Existing simple model IDs stay readable. IDs containing a slash, whitespace,
 * Unicode, or other path-significant bytes use a collision-resistant base64url
 * representation prefixed with `~` (which is intentionally outside the simple
 * ID alphabet).
 */
export function toPublicModelSlug(modelId: string): string {
	if (modelId.length > 0 && modelId.length <= 180 && SAFE_PUBLIC_MODEL_SLUG.test(modelId)) {
		return modelId;
	}
	const bytes = new TextEncoder().encode(modelId);
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return `~${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}
