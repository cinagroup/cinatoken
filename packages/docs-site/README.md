# CinaToken 文档模块

面向用户的中英文静态帮助文档，使用 Astro + Starlight，构建结果并入 Web 的同一份冻结发布产物。

```bash
npm ci
npm run dev:docs
npm run check:docs-site
npm run build:web
```

`/{en,zh}/docs/` 为页面；`/docs-assets/static/` 为带内容摘要的资源。
首批不启用搜索：索引需要先具备独立版本路径与旧产物保留策略，再纳入发布。

源码来源：本仓库按 CinaToken 当前行为编写的原创文档。信息结构调研参考
[OctaFuse/octafuse-website](https://github.com/OctaFuse/octafuse-website/tree/0d3984bad9b40b7091d9d9f56146df6a85a43ad3)，
没有复制该仓库源码、文章、截图或模型模板。调研时未发现其复用许可；后续迁移需先核实授权。

部署时设置 `CINATOKEN_WEB_DOCS_ENABLED=true`。关闭该开关只停用文档页面，既有版本资源继续可读。
Web Worker 与 Nginx 只拦截明确的文档 GET/HEAD 请求，账户、管理、认证与 API 仍沿用原有路径。
工程文档继续在根目录 `docs/` 维护，不在这里制造另一套配置说明。
