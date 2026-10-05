import { publicCatalogBff } from "@/lib/public-catalog-bff";

export function GET(request: Request): Promise<Response> {
	return publicCatalogBff("legacy-stats", request);
}
