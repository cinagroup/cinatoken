import type { MetadataRoute } from "next";
import { publicRobots } from "@/app/public-seo";

export default function robots(): MetadataRoute.Robots {
	return publicRobots();
}
