/**
 * CinaAuth -> CinaToken organization identity projection contract.
 *
 * CinaAuth remains authoritative for organizations and memberships. CinaToken
 * stores only the fields required to scope gateway resources and authorize
 * product actions. Billing balances and product entitlements intentionally do
 * not belong in this event contract.
 */

export const CINAUTH_ORGANIZATION_EVENT_TYPES = [
	'organization.upserted',
	'organization.deleted',
	'organization.membership.upserted',
	'organization.membership.removed',
] as const;

export type CinaAuthOrganizationEventType =
	(typeof CINAUTH_ORGANIZATION_EVENT_TYPES)[number];

export type CinaAuthOrganizationStatus = 'active' | 'suspended' | 'deleted';
export type CinaAuthOrganizationMembershipStatus = 'active' | 'suspended' | 'removed';

export type CinaAuthOrganizationEvent = {
	id: string;
	type: CinaAuthOrganizationEventType;
	occurredAt: string;
	organization: {
		/** Stable CinaAuth organization id; also used as the local projection id. */
		id: string;
		name?: string;
		slug?: string | null;
		status?: CinaAuthOrganizationStatus;
		metadata?: Record<string, unknown> | null;
		updatedAt?: string;
	};
	membership?: {
		/** Stable CinaAuth user id / OIDC subject. */
		subject: string;
		email?: string | null;
		/** CinaAuth role names are opaque to this service and may be dynamic. */
		roles: string[];
		status?: CinaAuthOrganizationMembershipStatus;
		updatedAt?: string;
	};
};

export type OrganizationMembershipProjection = {
	organizationId: string;
	organizationName: string;
	organizationSlug: string | null;
	organizationStatus: CinaAuthOrganizationStatus | 'pending';
	subject: string;
	userId: string | null;
	email: string | null;
	roles: string[];
	status: CinaAuthOrganizationMembershipStatus;
	sourceUpdatedAt: string;
};

const EVENT_TYPE_SET = new Set<string>(CINAUTH_ORGANIZATION_EVENT_TYPES);
const ORGANIZATION_STATUS_SET = new Set<string>(['active', 'suspended', 'deleted']);
const MEMBERSHIP_STATUS_SET = new Set<string>(['active', 'suspended', 'removed']);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

const record = (value: unknown, name: string): Record<string, unknown> => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`${name} must be an object`);
	}
	return value as Record<string, unknown>;
};

const requiredIdentifier = (value: unknown, name: string, maxLength = 255): string => {
	if (
		typeof value !== 'string' ||
		value.length === 0 ||
		value.length > maxLength ||
		!IDENTIFIER_PATTERN.test(value)
	) {
		throw new Error(`${name} is invalid`);
	}
	return value;
};

const optionalText = (
	value: unknown,
	name: string,
	maxLength: number,
): string | null | undefined => {
	if (value === undefined || value === null) return value;
	if (typeof value !== 'string') throw new Error(`${name} must be a string or null`);
	const normalized = value.trim();
	if (!normalized || normalized.length > maxLength) throw new Error(`${name} is invalid`);
	return normalized;
};

const isoTimestamp = (value: unknown, name: string): string => {
	if (typeof value !== 'string') throw new Error(`${name} must be an ISO timestamp`);
	const millis = Date.parse(value);
	if (!Number.isFinite(millis)) throw new Error(`${name} must be an ISO timestamp`);
	return new Date(millis).toISOString();
};

const optionalStatus = <T extends string>(
	value: unknown,
	name: string,
	allowed: ReadonlySet<string>,
): T | undefined => {
	if (value === undefined) return undefined;
	if (typeof value !== 'string' || !allowed.has(value)) {
		throw new Error(`${name} is invalid`);
	}
	return value as T;
};

const roles = (value: unknown): string[] => {
	if (!Array.isArray(value) || value.length > 32) {
		throw new Error('membership.roles must be an array');
	}
	const normalized = value.map((role, index) =>
		requiredIdentifier(role, `membership.roles[${index}]`, 128),
	);
	return [...new Set(normalized)].sort();
};

/** Parse and normalize an untrusted organization event. */
export function parseCinaAuthOrganizationEvent(input: unknown): CinaAuthOrganizationEvent {
	const root = record(input, 'event');
	const id = requiredIdentifier(root.id, 'event.id', 200);
	if (typeof root.type !== 'string' || !EVENT_TYPE_SET.has(root.type)) {
		throw new Error('event.type is unsupported');
	}
	const type = root.type as CinaAuthOrganizationEventType;
	const occurredAt = isoTimestamp(root.occurredAt, 'event.occurredAt');
	const rawOrganization = record(root.organization, 'event.organization');
	const organization: CinaAuthOrganizationEvent['organization'] = {
		id: requiredIdentifier(rawOrganization.id, 'organization.id'),
	};
	const name = optionalText(rawOrganization.name, 'organization.name', 512);
	if (name !== undefined && name !== null) organization.name = name;
	const slug = optionalText(rawOrganization.slug, 'organization.slug', 255);
	if (slug !== undefined) organization.slug = slug;
	const organizationStatus = optionalStatus<CinaAuthOrganizationStatus>(
		rawOrganization.status,
		'organization.status',
		ORGANIZATION_STATUS_SET,
	);
	if (organizationStatus) organization.status = organizationStatus;
	if (rawOrganization.metadata !== undefined) {
		organization.metadata = rawOrganization.metadata === null
			? null
			: record(rawOrganization.metadata, 'organization.metadata');
	}
	if (rawOrganization.updatedAt !== undefined) {
		organization.updatedAt = isoTimestamp(rawOrganization.updatedAt, 'organization.updatedAt');
	}

	if (type === 'organization.upserted' && !organization.name) {
		throw new Error('organization.name is required for organization.upserted');
	}
	if (type === 'organization.deleted') organization.status = 'deleted';

	let membership: CinaAuthOrganizationEvent['membership'];
	if (type.startsWith('organization.membership.')) {
		const rawMembership = record(root.membership, 'event.membership');
		membership = {
			subject: requiredIdentifier(rawMembership.subject, 'membership.subject'),
			email: optionalText(rawMembership.email, 'membership.email', 512),
			roles: roles(rawMembership.roles),
		};
		const membershipStatus = optionalStatus<CinaAuthOrganizationMembershipStatus>(
			rawMembership.status,
			'membership.status',
			MEMBERSHIP_STATUS_SET,
		);
		if (membershipStatus) membership.status = membershipStatus;
		if (rawMembership.updatedAt !== undefined) {
			membership.updatedAt = isoTimestamp(rawMembership.updatedAt, 'membership.updatedAt');
		}
		if (type === 'organization.membership.upserted' && membership.roles.length === 0) {
			throw new Error('membership.roles must not be empty for an active membership');
		}
		if (type === 'organization.membership.removed') {
			membership.status = 'removed';
			membership.roles = [];
		}
	}

	return { id, type, occurredAt, organization, ...(membership ? { membership } : {}) };
}

export function organizationEventAggregate(event: CinaAuthOrganizationEvent): {
	type: 'organization' | 'organization_membership';
	id: string;
} {
	if (!event.membership) return { type: 'organization', id: event.organization.id };
	return {
		type: 'organization_membership',
		id: `${event.organization.id}:${event.membership.subject}`,
	};
}
