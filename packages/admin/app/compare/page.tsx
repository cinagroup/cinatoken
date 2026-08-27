import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import PublicComparePage from '@/components/catalog/PublicComparePage';
import PublicHeader from '@/components/public/PublicHeader';
import PublicThemeBootstrap from '@/components/public/PublicThemeBootstrap';
import { fetchPublicCatalogModels } from '@/lib/public-catalog';

export async function generateMetadata(): Promise<Metadata> { const t = await getTranslations('publicCompare.metadata'); return { title: { absolute: t('title') }, description: t('description'), robots: { index: true, follow: true } }; }
export default async function ComparePage() { const catalog = await fetchPublicCatalogModels(); return <><PublicThemeBootstrap /><div className="home-surface min-h-screen overflow-x-hidden"><PublicHeader /><PublicComparePage catalog={catalog} /></div></>; }
