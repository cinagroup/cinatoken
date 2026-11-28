/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
	site: "https://cinatoken.com",
	trailingSlash: "always",
	build: { assets: "docs-assets/static" },
	integrations: [
		starlight({
			title: "CinaToken",
			defaultLocale: "en",
			locales: {
				en: { label: "English" },
				zh: { label: "简体中文", lang: "zh-CN" },
			},
			pagefind: true,
			disable404Route: true,
			credits: false,
			components: {
				Search: "./src/components/Search.astro",
				SiteTitle: "./src/components/SiteTitle.astro",
				SocialIcons: "./src/components/ProductLinks.astro",
				ThemeProvider: "./src/components/ThemeProvider.astro",
				ThemeSelect: "./src/components/ThemeSelect.astro",
			},
			customCss: ["./src/styles/docs.css"],
			favicon: "/web-assets/cinagroup-logo.31da4b7fb36b.png",
			editLink: {
				baseUrl:
					"https://github.com/cinagroup/cinatoken/edit/main/packages/docs-site/",
			},
			sidebar: [
				{
					label: "Start here",
					translations: { "zh-CN": "开始使用" },
					items: [
						{
							slug: "docs",
							label: "Overview",
							translations: { "zh-CN": "文档概览" },
						},
						{ slug: "docs/quickstart" },
						{ slug: "docs/authentication" },
						{ slug: "docs/keys" },
					],
				},
				{
					label: "Use the gateway",
					translations: { "zh-CN": "使用网关" },
					items: [
						{ slug: "docs/api" },
						{ slug: "docs/models" },
						{ slug: "docs/usage" },
						{ slug: "docs/troubleshooting" },
					],
				},
				{
					label: "Operate",
					translations: { "zh-CN": "管理平台" },
					items: [{ slug: "docs/administration" }],
				},
				{
					label: "Guides",
					translations: { "zh-CN": "功能指南" },
					items: [{ autogenerate: { directory: "docs/guides" } }],
				},
				{
					label: "Validation",
					translations: { "zh-CN": "调试验证" },
					items: [{ autogenerate: { directory: "docs/features" } }],
				},
				{
					label: "Deployment",
					translations: { "zh-CN": "部署运维" },
					items: [{ autogenerate: { directory: "docs/deploy" } }],
				},
				{ slug: "docs/capabilities" },
				{ slug: "docs/github-reference" },
				{
					label: "Reference catalog",
					translations: { "zh-CN": "配置参考目录" },
					items: [
						{ slug: "reference/catalog/models" },
						{ slug: "reference/catalog/providers" },
					],
				},
				{ slug: "updates" },
			],
		}),
	],
	vite: {
		environments: {
			client: {
				build: {
					rollupOptions: {
						output: {
							hashCharacters: "hex",
							entryFileNames: "docs-assets/static/[name].[hash:16].js",
							chunkFileNames: "docs-assets/static/[name].[hash:16].js",
							assetFileNames: "docs-assets/static/[name].[hash:16][extname]",
						},
					},
				},
			},
		},
	},
});
