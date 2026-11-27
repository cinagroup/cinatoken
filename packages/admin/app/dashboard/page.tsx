import { redirect } from 'next/navigation';

/** Retain bookmarked ranges while keeping one canonical overview URL. */
export default async function LegacyDashboardPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (Array.isArray(value)) value.forEach(item => query.append(key, item));
    else if (value !== undefined) query.append(key, value);
  }
  const suffix = query.toString();
  redirect(suffix ? `/admin?${suffix}` : '/admin');
}
