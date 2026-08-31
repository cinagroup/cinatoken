# CinaAuth organization identity boundary

## Ownership

CinaAuth is authoritative for organizations, memberships, teams, role names, OAuth applications, SSO and SCIM. CinaToken stores a read-side projection only for gateway resource scoping and product authorization. CinaToken usage, balances, budgets, model pricing and product entitlements remain in the CinaToken domain.

The projection never reads or writes the CinaAuth database. Stable CinaAuth organization ids and OIDC subjects are the integration keys.

## Signed event contract

CinaAuth delivers `POST /api/integrations/cinaauth/organization-events` with:

- `Content-Type: application/json`
- `x-cinaauth-event-timestamp: <unix-seconds>`
- `x-cinaauth-signature: v1=<lowercase HMAC-SHA256 hex>`
- signature input: `<timestamp>.<exact request body bytes>`

Both services receive the same independent `CINATOKEN_IDENTITY_EVENTS_SECRET` from their secret manager. Do not reuse the OIDC client, login transaction or administrator bridge secrets.

Supported event types are:

- `organization.upserted`
- `organization.deleted`
- `organization.membership.upserted`
- `organization.membership.removed`

Every event has a globally stable `id`, an ISO `occurredAt`, an `organization.id`, and—on membership events—a CinaAuth user `subject` plus an array of role names. Deletes and removals create tombstones instead of erasing audit context.

## Delivery and ordering guarantees

CinaAuth's organization hooks enqueue changes to the dedicated
`cinaauth-cinatoken-identity-events` Cloudflare Queue. Organization/member
creation, updates, role changes and removals use the same path; SSO and SCIM
automatic membership provisioning is read back from the authoritative
PostgreSQL rows before enqueue. The Queue consumer calls the `cinatoken-admin`
Service Binding, re-signs every attempt with a fresh timestamp, retries
transient failures with bounded exponential backoff, and routes exhausted
messages to `cinaauth-cinatoken-identity-events-dlq`.

`identity_event_inbox` and the projection write commit in one database transaction. A repeated event id with the same payload hash returns `duplicate`; the same id with different bytes returns HTTP 409 and is never applied. Projection rows compare `source_updated_at`, so a delayed older event cannot overwrite newer organization or membership state.

D1 uses transactional `batch()`. PostgreSQL and MySQL use explicit transactions. Membership events may arrive before an organization snapshot or the member's first CinaToken login: a pending organization placeholder is created, and the membership remains addressable by OIDC subject until it can be linked to the local `users` row.

## Security and operational limits

- The endpoint accepts at most 256 KiB, including chunked bodies.
- Signatures older or newer than five minutes are rejected. A retry may use a fresh timestamp/signature while retaining the same event id.
- HMAC verification uses Web Crypto and the stored payload digest is SHA-256.
- Event receipts are immutable for the PostgreSQL runtime role.
- Deploy migration `0038_organization_identity_projection.sql` before deploying the event consumer.
- Rotate the identity-event secret independently. During rotation, coordinate producer and consumer or support a reviewed dual-secret overlap; never log secret or signature values.
