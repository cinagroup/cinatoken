import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import PortalGate from '@/components/portal/PortalGate';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('portal.metadata');
  return {
    title: { absolute: t('title') },
    description: t('description'),
  };
}

export default function AccountLayout({ children }: { children: ReactNode }) {
  return <PortalGate>{children}</PortalGate>;
}
