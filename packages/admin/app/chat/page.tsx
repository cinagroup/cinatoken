import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import PublicChatPage from '@/components/chat/PublicChatPage';
import PublicHeader from '@/components/public/PublicHeader';
import PublicThemeBootstrap from '@/components/public/PublicThemeBootstrap';
import { fetchPublicCatalogModels } from '@/lib/public-catalog';

export async function generateMetadata(): Promise<Metadata> { const t = await getTranslations('publicChat.metadata'); return { title: { absolute: t('title') }, description: t('description'), robots: { index: false, follow: true } }; }
export default async function ChatPage() { const catalog = await fetchPublicCatalogModels(); return <><PublicThemeBootstrap /><div className="home-surface min-h-screen overflow-x-hidden"><PublicHeader /><PublicChatPage catalog={catalog} /></div></>; }
