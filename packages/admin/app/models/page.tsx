import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import PublicModelsPage from "@/components/catalog/PublicModelsPage";
import PublicHeader from "@/components/public/PublicHeader";
import PublicThemeBootstrap from "@/components/public/PublicThemeBootstrap";
import { fetchPublicCatalogModels } from "@/lib/public-catalog";
import { publicPageMetadata } from "@/app/public-seo";

export async function generateMetadata(): Promise<Metadata> {
	const t = await getTranslations("publicModels.metadata");
	return publicPageMetadata("/models", t("title"), t("description"));
}

export default async function ModelsPage() {
	const catalog = await fetchPublicCatalogModels();
	return (
		<>
			<PublicThemeBootstrap />
			<div className="home-surface min-h-screen overflow-x-hidden">
				<PublicHeader />
				<PublicModelsPage catalog={catalog} />
			</div>
		</>
	);
}
