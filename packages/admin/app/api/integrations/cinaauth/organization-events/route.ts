import { NextResponse } from 'next/server';
import {
	applyOrganizationIdentityEvent,
	parseCinaAuthOrganizationEvent,
} from '@octafuse/core';
import { resolveAdminRequestRuntime } from '@/lib/admin-request-runtime';
import { getCinaAuthIdentityEventsSecret } from '@/lib/cinaauth/config';
import {
	readLimitedCinaAuthEventBody,
	sha256Hex,
	verifyCinaAuthOrganizationEventSignature,
} from '@/lib/cinaauth/organization-event-signature';

export const dynamic = 'force-dynamic';

const json = (body: unknown, status: number): NextResponse =>
	NextResponse.json(body, {
		status,
		headers: { 'Cache-Control': 'no-store' },
	});

/** Signed, idempotent CinaAuth organization projection endpoint. */
export async function POST(request: Request): Promise<NextResponse> {
	const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';
	if (!contentType.startsWith('application/json')) {
		return json({ ok: false, error: 'unsupported_media_type' }, 415);
	}

	let body: Uint8Array;
	try {
		body = await readLimitedCinaAuthEventBody(request);
	} catch {
		return json({ ok: false, error: 'event_body_too_large' }, 413);
	}

	let identityEventsSecret: string;
	try {
		identityEventsSecret = getCinaAuthIdentityEventsSecret(request);
	} catch {
		return json({ ok: false, error: 'integration_not_configured' }, 503);
	}
	const signature = await verifyCinaAuthOrganizationEventSignature(
		request,
		body,
		identityEventsSecret,
	);
	if (!signature.ok) {
		return json({ ok: false, error: 'invalid_signature' }, 401);
	}

	let event;
	try {
		const decoded = new TextDecoder('utf-8', { fatal: true }).decode(body);
		event = parseCinaAuthOrganizationEvent(JSON.parse(decoded));
	} catch (error) {
		return json(
			{
				ok: false,
				error: 'invalid_event',
				message: error instanceof Error ? error.message : 'Invalid event',
			},
			400,
		);
	}

	try {
		const { storage } = await resolveAdminRequestRuntime(request);
		const result = await applyOrganizationIdentityEvent(storage.repositories.client, {
			event,
			payloadSha256: await sha256Hex(body),
		});
		if (result === 'conflict') {
			return json({ ok: false, error: 'event_id_payload_conflict', eventId: event.id }, 409);
		}
		return json(
			{ ok: true, eventId: event.id, result },
			result === 'applied' ? 202 : 200,
		);
	} catch (error) {
		console.error('cinatoken.cinaauth_organization_event_failed', {
			eventId: event.id,
			eventType: event.type,
			error: error instanceof Error ? error.message : 'unknown',
		});
		return json({ ok: false, error: 'organization_event_failed' }, 500);
	}
}
