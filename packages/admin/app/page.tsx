import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import PublicHome from '@/components/home/PublicHome';

export async function generateMetadata(): Promise<Metadata> {
	const t = await getTranslations('home.metadata');

	return {
		title: { absolute: t('title') },
		description: t('description'),
		robots: {
			index: true,
			follow: true,
		},
	};
}

export default function HomePage() {
	return <PublicHome />;
}
