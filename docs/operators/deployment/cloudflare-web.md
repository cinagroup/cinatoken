# 独立 Web 的 Cloudflare 发布与切流

`cinatoken-web` 提供公开 SSR、账户与管理页面；`cinatoken-admin` 继续提供认证、API、BFF 和旧路由兼容。Web 只有 `ASSETS` 与 `CINATOKEN_ADMIN_SERVICE`，不绑定数据库、Queue 或业务密钥。

生产入口使用已有 Zone Route `cinatoken.com/*`，不是新的 Custom Domain。`api.cinatoken.com/*` 始终由 `cinatoken-proxy` 提供。Admin 的默认 Wrangler 模板不再认领主域名；发布 Admin 时不要设置 `ADMIN_CUSTOM_DOMAIN=cinatoken.com`。

## 发布产物

1. 选用对应提交已通过 Web frontend CI 的 `.release/web/<SHA>` 产物，或运行 `npm run build:web` 后使用 `packages/web/scripts/package-release.mjs` 冻结新版本。禁止直接发布旧 `dist`。
2. 执行 `node packages/web/scripts/package-release.mjs --verify <release-id>`，记录源码提交、manifest SHA、三目标 build contract 与 Worker version。
3. 生成配置时设置 `CINATOKEN_WEB_PUBLIC_ORIGIN=https://cinatoken.com`、`CINATOKEN_WEB_PROXY_ORIGINS=https://api.cinatoken.com`。29 个 `CINATOKEN_WEB_*_ENABLED` 是页面开关；API 与 OIDC 始终转发原始请求至 Admin。
4. 先保持 Web `routes: []`，部署并通过预览/Service Binding 验证。只对临时预览开启 `workers_dev`，正式切流后关闭它。后续正式配置使用 `workers_dev:false`、`preview_urls:false`，不要复用开启预览的临时配置。公开 SSR 必须实际经过 Cloudflare；Node 测试不能证明所有 workerd API 可用。
5. 验收公开四语 SSR、静态资源与懒加载、账户和管理页面的权限拦截、匿名 API 401、同源认证 URL、移动布局、语言及主题刷新。真实登录、资金和链操作按其专项证据单独记录。

## 切流与回滚

脚本只修改固定的生产前端 Route，默认只读；要求目标 Worker 已以指定 version 获得 100% 流量。发现路由归属或目标版本漂移时停止。记录路径必须是新的文件。

```powershell
node scripts/deploy/switch-web-route.mjs --to web --expected-version <verified-web-version> --record <new-preflight.json>
node scripts/deploy/switch-web-route.mjs --to web --expected-version <verified-web-version> --record <new-activation.json> --apply
```

切流后再次核对 Route、Worker version、HTML `/web-assets/`、公开 SSR/API 与浏览器交互。若切流后出现不可接受的错误，立即使用原 Admin version 恢复入口：

```powershell
node scripts/deploy/switch-web-route.mjs --to admin --expected-version <original-admin-version> --record <new-rollback.json> --apply
```

回滚只改变页面入口，不回滚数据库或资金状态。切流前须为 `cinatoken.com/web-assets/*` 保留单独的 Web Route；恢复主 Route 至 Admin 时保留这条资源 Route，使已打开的 Web 标签页仍能加载资源。保留冻结产物与原版本至少 14 天，2026-10-05 的版本至少保留至 2026-10-19。

2026-10-05 已实际切流：主 Route `5738534653ef46f48a44e3f3b22e5d8e` 和资源 Route `2712df1859d340ffb6d68a7e53eb1853` 均由 `cinatoken-web` 接管；Web 源码提交 `bdc1bfcf15d93a9b2769d3f52352bfa39eab8928`、version `ecba2f94-90a3-4e32-af20-9fd9d3718811`、流量 100%。Admin 回滚目标仍为 version `a5ce22c4-edae-42e9-8c2b-7b0df63e5b66`。Proxy Route、Admin/Proxy 的部署版本和数据库未因本次 Web 切流而改变。实际验收与预览关闭状态见 [切流记录](releases/2026-10-05-independent-web-cutover.json)。

验收后仅关闭该脚本的 Workers.dev 和 Preview 访问：对 `/accounts/7ea8e46d8210bad342fa7595f7935fea/workers/scripts/cinatoken-web/subdomain` 执行 `POST {"enabled":false,"previews_enabled":false}`，随后 GET 确认两值为 false，并复核生产 Route、部署 UUID 与生产页面。这项操作无需重新上传 Worker 或修改 Zone Route；不要删除账户级 subdomain。接口依据 [Cloudflare 官方 schema](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/methods/create/)。

本次生产 45 项页面功能及主题/中文/移动刷新通过，但严格浏览器检查实际退出 1：Cloudflare 自动 Web Analytics 注入触发 37 条私有页 CSP 拒绝和 32 次被只读测试守卫阻断的 RUM POST。非遥测失败请求为 0，安全策略保持。分析站点 `566e5ee06705450abf29272ec21b3b76` / ruleset `4e2b52a8-2c7d-46bc-8c4a-e34f93c4e822` 的原默认包含规则未变；精确主机排除写入及备用配置规则读取均被 Cloudflare 403 拒绝，严格验收未标为通过。

后续使用具有对应写权限的凭据，仅对 `cinatoken.com` 停止冲突注入：可新增 RUM 主机排除规则 `host:"cinatoken.com", paths:["*"], inclusive:false, is_paused:false`，保留其他主机和原规则；或追加 `http_config_settings` 配置规则，匹配 `http.host eq "cinatoken.com"`，设置 `disable_rum:true`。不得覆盖整个规则列表。读回后复验浏览器；回滚此配置仅删除新规则 ID。依据 [RUM 规则 API](https://developers.cloudflare.com/api/resources/rum/subresources/rules/methods/create/) 与 [配置规则 API](https://developers.cloudflare.com/rules/configuration-rules/create-api/)。

主实施状态及验收门槛只维护在 [Web 前端迁移 checklist](../../developers/architecture/web-frontend-migration.md)，发布版本与实际结果保存在 `releases/`。
