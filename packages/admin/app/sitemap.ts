import type { MetadataRoute } from "next";
import { fetchPublicCatalogModels } from "@/lib/public-catalog";
import { publicSitemap } from "@/app/public-seo";

export const revalidate = 60;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
	return publicSitemap(await fetchPublicCatalogModels());
}
