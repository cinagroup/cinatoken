const PUBLIC_ENDPOINT_TAG = /^[A-Za-z0-9][A-Za-z0-9._:/~-]{0,127}$/u;

export const PUBLIC_CATALOG_TOP_PROVIDER_METADATA_KEY = 'public_catalog_top_provider';

export type PublicCatalogTopProviderSelector = {
	endpointTag: string;
	isModerated: boolean;
};

export type PublicCatalogTopProviderSelection =
	| { status: 'absent' }
	| { status: 'invalid' }
	| { status: 'valid'; selector: PublicCatalogTopProviderSelector };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse the only model-metadata field that may choose the public Models API
 * top provider. The strict shape keeps arbitrary metadata out of the public
 * catalog and makes malformed operator intent fail closed.
 */
export function parsePublicCatalogTopProviderSelection(
	metadata: Readonly<Record<string, unknown>> | null
): PublicCatalogTopProviderSelection {
	if (
		metadata === null
		|| !Object.prototype.hasOwnProperty.call(
			metadata,
			PUBLIC_CATALOG_TOP_PROVIDER_METADATA_KEY
		)
	) return { status: 'absent' };

	const value = metadata[PUBLIC_CATALOG_TOP_PROVIDER_METADATA_KEY];
	if (!isRecord(value)) return { status: 'invalid' };
	const keys = Object.keys(value);
	if (
		keys.length !== 2
		|| !keys.includes('endpoint_tag')
		|| !keys.includes('is_moderated')
		|| typeof value.endpoint_tag !== 'string'
		|| !PUBLIC_ENDPOINT_TAG.test(value.endpoint_tag)
		|| typeof value.is_moderated !== 'boolean'
	) return { status: 'invalid' };

	return {
		status: 'valid',
		selector: {
			endpointTag: value.endpoint_tag,
			isModerated: value.is_moderated,
		},
	};
}
