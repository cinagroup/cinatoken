import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import PublicProvidersPage from "@/components/catalog/PublicProvidersPage";
import PublicHeader from "@/components/public/PublicHeader";
import PublicThemeBootstrap from "@/components/public/PublicThemeBootstrap";
import { fetchPublicCatalogProviders } from "@/lib/public-catalog";
import { publicPageMetadata } from "@/app/public-seo";

export async function generateMetadata(): Promise<Metadata> {
	const t = await getTranslations("publicProviders.metadata");
	return publicPageMetadata("/providers", t("title"), t("description"));
}

export default async function ProvidersPage() {
	const catalog = await fetchPublicCatalogProviders();
	return (
		<>
			<PublicThemeBootstrap />
			<div className="home-surface min-h-screen overflow-x-hidden">
				<PublicHeader />
				<PublicProvidersPage catalog={catalog} />
			</div>
		</>
	);
}
