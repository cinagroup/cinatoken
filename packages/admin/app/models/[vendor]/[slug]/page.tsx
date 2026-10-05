import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import PublicModelDetail from "@/components/catalog/PublicModelDetail";
import PublicHeader from "@/components/public/PublicHeader";
import PublicThemeBootstrap from "@/components/public/PublicThemeBootstrap";
import { fetchPublicCatalogModel } from "@/lib/public-catalog";
import { publicModelPath, publicPageMetadata } from "@/app/public-seo";

type PageProps = { params: Promise<{ vendor: string; slug: string }> };

export async function generateMetadata({
	params,
}: PageProps): Promise<Metadata> {
	const { vendor, slug } = await params;
	const pathname = publicModelPath(vendor, slug);
	if (!pathname) notFound();
	const result = await fetchPublicCatalogModel(vendor, slug);
	const t = await getTranslations("publicModelDetail.metadata");
	if (result.status === "not-found") notFound();
	if (result.status !== "ready" || !result.model) {
		return publicPageMetadata(pathname, t("fallbackTitle"), "", false);
	}
	const title = t("title", { model: result.model.displayName });
	const description =
		result.model.description ??
		t("description", {
			model: result.model.displayName,
			vendor: result.model.vendor,
		});
	return publicPageMetadata(pathname, title, description);
}

export default async function ModelDetailPage({ params }: PageProps) {
	const { vendor, slug } = await params;
	if (!publicModelPath(vendor, slug)) notFound();
	const result = await fetchPublicCatalogModel(vendor, slug);
	if (result.status === "not-found") notFound();
	return (
		<>
			<PublicThemeBootstrap />
			<div className="home-surface min-h-screen overflow-x-hidden">
				<PublicHeader />
				<PublicModelDetail result={result} />
			</div>
		</>
	);
}
