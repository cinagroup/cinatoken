import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import PublicModelDetail from '@/components/catalog/PublicModelDetail';
import PublicHeader from '@/components/public/PublicHeader';
import PublicThemeBootstrap from '@/components/public/PublicThemeBootstrap';
import { fetchPublicCatalogModel } from '@/lib/public-catalog';

type PageProps = { params: Promise<{ vendor: string; slug: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
	const { vendor, slug } = await params;
	const result = await fetchPublicCatalogModel(vendor, slug);
	const t = await getTranslations('publicModelDetail.metadata');
	if (result.status !== 'ready' || !result.model) {
		return { title: { absolute: t('fallbackTitle') }, robots: { index: false, follow: false } };
	}
	return {
		title: { absolute: t('title', { model: result.model.displayName }) },
		description: result.model.description ?? t('description', { model: result.model.displayName, vendor: result.model.vendor }),
		robots: { index: true, follow: true },
	};
}

export default async function ModelDetailPage({ params }: PageProps) {
	const { vendor, slug } = await params;
	const result = await fetchPublicCatalogModel(vendor, slug);
	if (result.status === 'not-found') notFound();
	return <><PublicThemeBootstrap /><div className="home-surface min-h-screen overflow-x-hidden"><PublicHeader /><PublicModelDetail result={result} /></div></>;
}
