import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import PublicHome from "@/components/home/PublicHome";
import { publicPageMetadata } from "@/app/public-seo";

export async function generateMetadata(): Promise<Metadata> {
	const t = await getTranslations("home.metadata");

	return publicPageMetadata("/", t("title"), t("description"));
}

export default function HomePage() {
	return <PublicHome />;
}
