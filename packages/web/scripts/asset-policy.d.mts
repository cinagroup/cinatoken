export const HASHED_ASSET_PATTERN: string
export const SOURCE_ARCHIVE_PATTERN: string
export const IMMUTABLE_CACHE: string
export const REVALIDATE_CACHE: string
export const NO_STORE_CACHE: string
export function isHashedAsset(path: string): boolean
export function isSourceArchiveAsset(path: string): boolean
export function isRetainableAsset(path: string): boolean
export function assetCacheControl(path: string, status: number): string
