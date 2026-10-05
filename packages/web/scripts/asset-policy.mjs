// These ASCII paths and extensions deliberately exclude HTML and mutable data.
export const HASHED_ASSET_PATTERN =
	'static/[A-Za-z0-9_./-]+[.][a-f0-9]{8,64}[.](?:js|css|woff2?|ttf|otf|png|jpe?g|svg|webp|avif|ico)(?:[.]LICENSE[.]txt)?'
export const SOURCE_ARCHIVE_PATTERN = 'sources/web[.][a-f0-9]{64}[.]tar[.]gz'
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable'
export const REVALIDATE_CACHE = 'no-cache'
export const NO_STORE_CACHE = 'no-store'

const hashedAsset = new RegExp(`^${HASHED_ASSET_PATTERN}$`)
const sourceArchiveAsset = new RegExp(`^${SOURCE_ARCHIVE_PATTERN}$`)

export function isHashedAsset(path) {
	return hashedAsset.test(path)
}

export function isSourceArchiveAsset(path) {
	return sourceArchiveAsset.test(path)
}

export function isRetainableAsset(path) {
	return isHashedAsset(path) || isSourceArchiveAsset(path)
}

export function assetCacheControl(path, status) {
	if (![200, 206, 304].includes(status) || /[.]html?$/i.test(path)) {
		return NO_STORE_CACHE
	}
	return isRetainableAsset(path) ? IMMUTABLE_CACHE : REVALIDATE_CACHE
}
