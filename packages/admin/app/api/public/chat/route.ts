import { NextRequest, NextResponse } from 'next/server';
import { fetchPublicGateway } from '@/lib/public-gateway';
import {
	coercePublicChatRequest,
	PublicChatBodyTooLargeError,
	readPublicChatBodyWithinLimit,
} from '@/lib/public-chat';

export async function POST(request: NextRequest) {
	const authorization = request.headers.get('authorization') ?? '';
	if (!/^Bearer [^\s]{8,512}$/.test(authorization)) return NextResponse.json({ error: { message: 'A valid API key is required' } }, { status: 401 });
	try {
		const authentication = await fetchPublicGateway('/v1/me', {
			method: 'GET',
			headers: { authorization, accept: 'application/json' },
			signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
			cache: 'no-store',
		}, { request });
		await authentication.body?.cancel('public_chat_authentication_complete').catch(() => undefined);
		if (!authentication.ok) {
			const status = authentication.status === 401 || authentication.status === 403 ? 401 : 502;
			return NextResponse.json({ error: { message: status === 401 ? 'A valid API key is required' : 'Gateway unavailable' } }, { status });
		}
	} catch {
		return NextResponse.json({ error: { message: 'Gateway unavailable' } }, { status: 502 });
	}
	let input: unknown;
	try {
		const raw = await readPublicChatBodyWithinLimit(request);
		input = JSON.parse(raw);
	} catch (error) {
		if (error instanceof PublicChatBodyTooLargeError) return NextResponse.json({ error: { message: 'Request is too large' } }, { status: 413 });
		return NextResponse.json({ error: { message: 'Invalid JSON body' } }, { status: 400 });
	}
	const chatRequest = coercePublicChatRequest(input);
	if (!chatRequest) return NextResponse.json({ error: { message: 'Invalid model or messages' } }, { status: 400 });
	try {
		const signal = AbortSignal.any([request.signal, AbortSignal.timeout(300_000)]);
		const upstream = await fetchPublicGateway('/v1/chat/completions', {
			method: 'POST', headers: { authorization, 'content-type': 'application/json', accept: 'text/event-stream' },
			body: JSON.stringify({ ...chatRequest, stream: true }), signal, cache: 'no-store',
		}, { request });
		return new NextResponse(upstream.body, {
			status: upstream.status,
			headers: {
				'content-type': upstream.headers.get('content-type') ?? 'application/json',
				'cache-control': 'no-store, no-transform',
				'x-accel-buffering': 'no',
				...(upstream.headers.get('retry-after')
					? { 'retry-after': upstream.headers.get('retry-after')! }
					: {}),
			},
		});
	} catch {
		return NextResponse.json({ error: { message: 'Gateway unavailable' } }, { status: 502, headers: { 'cache-control': 'no-store' } });
	}
}
