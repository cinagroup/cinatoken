import { NextRequest, NextResponse } from 'next/server';
import { fetchPublicModelStats } from '@/lib/public-catalog';

export async function GET(request: NextRequest) {
	const raw = request.nextUrl.searchParams.get('range') ?? '7d';
	if (raw !== '7d' && raw !== '30d' && raw !== '90d') {
		return NextResponse.json({ error: 'invalid_range' }, { status: 400 });
	}
	const result = await fetchPublicModelStats(raw);
	return NextResponse.json(result, { headers: { 'cache-control': 'public, max-age=60, stale-while-revalidate=300' } });
}
