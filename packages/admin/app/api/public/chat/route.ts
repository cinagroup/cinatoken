import { NextRequest, NextResponse } from 'next/server';
import { resolvePublicApiOrigin } from '@/lib/public-catalog';
import { coercePublicChatRequest } from '@/lib/public-chat';

const MAX_BODY_BYTES = 128 * 1024;

export async function POST(request: NextRequest) {
	const contentLength = Number(request.headers.get('content-length') ?? 0);
	if (!Number.isFinite(contentLength) || contentLength > MAX_BODY_BYTES) return NextResponse.json({ error: { message: 'Request is too large' } }, { status: 413 });
	const authorization = request.headers.get('authorization') ?? '';
	if (!/^Bearer [^\s]{8,512}$/.test(authorization)) return NextResponse.json({ error: { message: 'A valid API key is required' } }, { status: 401 });
	let input: unknown;
	try {
		const raw = await request.text();
		if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return NextResponse.json({ error: { message: 'Request is too large' } }, { status: 413 });
		input = JSON.parse(raw);
	} catch { return NextResponse.json({ error: { message: 'Invalid JSON body' } }, { status: 400 }); }
	const chatRequest = coercePublicChatRequest(input);
	if (!chatRequest) return NextResponse.json({ error: { message: 'Invalid model or messages' } }, { status: 400 });
	try {
		const upstream = await fetch(`${resolvePublicApiOrigin()}/v1/chat/completions`, {
			method: 'POST', headers: { authorization, 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify({ ...chatRequest, stream: false }), signal: AbortSignal.timeout(120_000), cache: 'no-store',
		});
		return new NextResponse(await upstream.text(), { status: upstream.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
	} catch {
		return NextResponse.json({ error: { message: 'Gateway unavailable' } }, { status: 502, headers: { 'cache-control': 'no-store' } });
	}
}
