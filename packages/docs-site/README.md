# CinaToken 内容站

原创中英文指南、更新归档和配置参考使用 Astro + Starlight，构建结果并入 Web 的冻结发布产物。工程配置的权威说明仍在根目录 `docs/`。

```bash
npm ci
npm run dev:docs
npm run check:sync -w @cinatoken/docs-site
npm run check:docs-site
npm run build:web
```

页面为 `/{en,zh}/{docs,updates,reference}/`；日文、韩文产品导航明确链接到英文内容。
全文搜索按需加载，所有索引成员的原始字节共同决定 `/docs-assets/search/<sha256>/` 版本；旧版本随冻结产物保留。开发模式未生成索引时搜索按钮禁用。`/content-sitemap.xml` 收录双语内容，`/updates.xml` 仅发布 CinaToken 原创更新。

## 来源与显式更新

网站结构调研固定于 [OctaFuse/octafuse-website](https://github.com/OctaFuse/octafuse-website/tree/0d3984bad9b40b7091d9d9f56146df6a85a43ad3)。未发现该网站的复用许可，因此不复制其代码、文章、截图或目录数据。更新归档仅引用版本、日期和原文链接，保持 OctaFuse 身份。

配置参考来自本仓库已有 AGPL 许可的预设，当前为 206 个模型、69 个供应商。生成器固定提交、记录每个输入摘要并移除部署私有密钥映射。构建仅消费已提交快照；`check:sync` 检查本地预设漂移、路由清单和上游索引结构，不联网更新来源。

```bash
# 预设变更先提交，再以完整提交生成并审阅快照。
npm run sync:catalog -w @cinatoken/docs-site -- --write --ref <reviewed-40-hex-sha>
# 只读取指定提交的日期与路径。新非版本文章需补充原创索引标签。
node packages/docs-site/scripts/sync-upstream.mjs --write --upstream-repo /path/to/octafuse-website --ref <reviewed-40-hex-sha>
npm run sync:routes -w @cinatoken/docs-site -- --write
npm run check:sync -w @cinatoken/docs-site
```

`Review website source drift` 手动 GitHub 工作流只生成补丁与审阅清单，权限为只读。下载后在 `codex/` 分支应用，按 [审阅清单](sync/review-checklist.md) 提交 PR。未知来源变化会使生成失败，不能自动发布价格或导入生产数据。普通 PR 的 Web CI 强制检查已提交快照，并从固定上游提交核对日期、版本与输入摘要。

## 同域目录接口

- `/reference/api/catalog/models`、`/reference/api/catalog/providers`
- `/reference/api/catalog/models-by-vendor/deepseek`
- 同时支持 `/reference/catalog/` 前缀和 `.json` 后缀。

响应支持 GET/HEAD、ETag/304、公开 CORS 和 OPTIONS；缓存 300 秒，未知资源返回 JSON 404。写请求仍沿用后端路径。该参考接口独立于 `/api/public/catalog/models` 的实时可调用目录，导入预览不会直接修改数据库。

新 feed 完成生产核对后，将 Admin 的 `CATALOG_BASE_URL` 配为 `https://cinatoken.com/reference`；只改变目录来源，不替换实时模型或端点配置。回退可恢复原变量并发布上一 Admin 版本。

## 发布与回退

`CINATOKEN_WEB_DOCS_ENABLED=true` 开启内容页面；关闭时页面返回 503，既有版本资源、JSON feed 和站点地图仍可读。Worker 与 Nginx 仅接管明确的静态读请求，账户、管理、认证与业务 API 保持原路径。

发布需要根目录 `typecheck:web`、`typecheck:admin`，Web 格式、lint、测试、三目标构建及 Docker HTTP 检查。使用精确主分支 CI 冻结产物，与当前生产冻结产物组合后部署；保留旧搜索索引与源码映射，并核对全部资源。完整范围见 [验收清单](sync/implementation-plan.md)。
