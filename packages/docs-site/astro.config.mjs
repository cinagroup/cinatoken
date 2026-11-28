/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'

export default defineConfig({
  site: 'https://cinatoken.com',
  trailingSlash: 'always',
  build: { assets: 'docs-assets/static' },
  integrations: [starlight({
    title: 'CinaToken',
    defaultLocale: 'en',
    locales: { en: { label: 'English' }, zh: { label: '简体中文', lang: 'zh-CN' } },
    // Search is enabled only once its versioned index joins the release contract.
    pagefind: false,
    disable404Route: true,
    credits: false,
    components: { SiteTitle: './src/components/SiteTitle.astro', SocialIcons: './src/components/ProductLinks.astro', ThemeProvider: './src/components/ThemeProvider.astro', ThemeSelect: './src/components/ThemeSelect.astro' },
    customCss: ['./src/styles/docs.css'],
    favicon: '/web-assets/cinagroup-logo.31da4b7fb36b.png',
    editLink: { baseUrl: 'https://github.com/cinagroup/cinatoken/edit/main/packages/docs-site/' },
    sidebar: [
      { label: 'Start here', translations: { 'zh-CN': '开始使用' }, items: [
        { slug: 'docs', label: 'Overview', translations: { 'zh-CN': '文档概览' } },
        { slug: 'docs/quickstart' }, { slug: 'docs/authentication' }, { slug: 'docs/keys' },
      ] },
      { label: 'Use the gateway', translations: { 'zh-CN': '使用网关' }, items: [
        { slug: 'docs/api' }, { slug: 'docs/models' }, { slug: 'docs/usage' }, { slug: 'docs/troubleshooting' },
      ] },
      { label: 'Operate', translations: { 'zh-CN': '管理平台' }, items: [{ slug: 'docs/administration' }] },
    ],
  })],
  vite: { environments: { client: { build: { rollupOptions: { output: {
    hashCharacters: 'hex',
    entryFileNames: 'docs-assets/static/[name].[hash:16].js',
    chunkFileNames: 'docs-assets/static/[name].[hash:16].js',
    assetFileNames: 'docs-assets/static/[name].[hash:16][extname]',
  } } } } } },
})
