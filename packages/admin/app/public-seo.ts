import type { Metadata, MetadataRoute } from "next";
import type { PublicCatalogResult } from "@/lib/public-catalog";

const DEFAULT_SITE_ORIGIN = "https://cinatoken.com";
const INDEXABLE_PATHS = [
	"/",
	"/models",
	"/providers",
	"/compare",
	"/rankings",
	"/benchmarks",
] as const;

/** A configured origin is trusted only when it is one exact HTTPS authority. */
export function publicSiteOrigin(
	raw = process.env.CINATOKEN_APP_ORIGIN
): string | null {
	if (raw === undefined) return DEFAULT_SITE_ORIGIN;
	try {
		const url = new URL(raw);
		return url.protocol === "https:" &&
			!url.username &&
			!url.password &&
			!url.port &&
			url.pathname === "/" &&
			!url.search &&
			!url.hash &&
			url.origin === raw
			? url.origin
			: null;
	} catch {
		return null;
	}
}

function absolutePublicUrl(pathname: string, origin: string): string {
	if (
		!pathname.startsWith("/") ||
		pathname.startsWith("//") ||
		pathname.includes("?") ||
		pathname.includes("#")
	) {
		throw new TypeError("Public SEO path must be a pathname");
	}
	return `${origin}${pathname}`;
}

export function publicPageMetadata(
	pathname: string,
	title: string,
	description: string,
	index = true,
	origin = publicSiteOrigin()
): Metadata {
	const indexable = index && origin !== null;
	const url = origin === null ? null : absolutePublicUrl(pathname, origin);
	return {
		title: { absolute: title },
		description,
		robots: { index: indexable, follow: true },
		...(indexable && url
			? {
					alternates: { canonical: url },
					openGraph: {
						type: "website" as const,
						url,
						siteName: "CinaToken",
						title,
						description,
					},
					twitter: { card: "summary" as const, title, description },
			  }
			: {}),
	};
}

export function publicModelPath(vendor: string, slug: string): string | null {
	// Match the published catalog's single route segments. A dot segment or
	// encoded slash could otherwise produce a sitemap URL for another route.
	if (
		!/^[a-z0-9][a-z0-9._-]{0,79}$/u.test(vendor) ||
		vendor === "." ||
		vendor === ".." ||
		!/^[A-Za-z0-9._:~-]{1,256}$/u.test(slug) ||
		slug === "." ||
		slug === ".."
	) {
		return null;
	}
	return `/models/${encodeURIComponent(vendor)}/${encodeURIComponent(slug)}`;
}

export function publicSitemap(
	catalog: PublicCatalogResult,
	origin = publicSiteOrigin()
): MetadataRoute.Sitemap {
	if (!origin) return [];
	const urls = new Set<string>(
		INDEXABLE_PATHS.map((path) => absolutePublicUrl(path, origin))
	);
	if (catalog.status === "ready") {
		for (const model of catalog.models) {
			const path = publicModelPath(model.vendor, model.slug);
			if (path) urls.add(absolutePublicUrl(path, origin));
		}
	}
	return [...urls].map((url) => ({ url }));
}

export function publicRobots(
	origin = publicSiteOrigin()
): MetadataRoute.Robots {
	if (!origin) return { rules: { userAgent: "*", disallow: "/" } };
	return {
		rules: {
			userAgent: "*",
			allow: "/",
			disallow: [
				"/account",
				"/dashboard",
				"/gateway",
				"/admin",
				"/api",
				"/chat",
			],
		},
		sitemap: absolutePublicUrl("/sitemap.xml", origin),
	};
}
