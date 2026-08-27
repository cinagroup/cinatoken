import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import PublicStatsPage from '@/components/catalog/PublicStatsPage';
import PublicHeader from '@/components/public/PublicHeader';
import PublicThemeBootstrap from '@/components/public/PublicThemeBootstrap';
import { fetchPublicModelStats } from '@/lib/public-catalog';

export async function generateMetadata(): Promise<Metadata> { const t = await getTranslations('publicRankings.metadata'); return { title: { absolute: t('title') }, description: t('description'), robots: { index: true, follow: true } }; }
export default async function RankingsPage() { const initial = await fetchPublicModelStats('7d'); return <><PublicThemeBootstrap /><div className="home-surface min-h-screen overflow-x-hidden"><PublicHeader /><PublicStatsPage initial={initial} mode="rankings" /></div></>; }
