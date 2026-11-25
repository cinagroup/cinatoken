/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslations } from "next-intl";
import { CINATOKEN_GITHUB_REPO_WEB } from "@/lib/brand";

// Keep the shared legacy entry point so fallback pages use the same quiet footer.
export default function FrontendAttribution({
	compact = false,
}: {
	compact?: boolean;
}) {
	const t = useTranslations("home.footer");
	return (
		<p
			className={`flex flex-wrap gap-x-3 gap-y-1 ${
				compact ? "text-[10px] leading-4" : "text-xs leading-5"
			}`}
		>
			<a
				href={`${CINATOKEN_GITHUB_REPO_WEB}/tree/main/packages/web`}
				target="_blank"
				rel="noopener noreferrer"
				className="underline underline-offset-2"
			>
				{t("sourceDownload")}
			</a>
			<a
				href={`${CINATOKEN_GITHUB_REPO_WEB}/blob/main/NOTICE.frontend`}
				target="_blank"
				rel="noopener noreferrer"
				className="underline underline-offset-2"
			>
				{t("license")}
			</a>
		</p>
	);
}
