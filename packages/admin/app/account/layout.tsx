import type { ReactNode } from 'react';
import PortalGate from '@/components/portal/PortalGate';

export default function AccountLayout({ children }: { children: ReactNode }) {
  return <PortalGate>{children}</PortalGate>;
}
