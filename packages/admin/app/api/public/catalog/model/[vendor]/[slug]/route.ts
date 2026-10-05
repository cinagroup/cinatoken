import { publicCatalogBff } from "@/lib/public-catalog-bff";

export async function GET(
	request: Request,
	context: { params: Promise<{ vendor: string; slug: string }> }
): Promise<Response> {
	return publicCatalogBff("model", request, await context.params);
}
