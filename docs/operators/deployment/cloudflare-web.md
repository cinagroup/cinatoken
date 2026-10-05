# 独立 Web 的 Cloudflare 发布与切流

`cinatoken-web` 提供公开 SSR、账户与管理页面；`cinatoken-admin` 继续提供认证、API、BFF 和旧路由兼容。Web 只有 `ASSETS` 与 `CINATOKEN_ADMIN_SERVICE`，不绑定数据库、Queue 或业务密钥。

生产入口使用已有 Zone Route `cinatoken.com/*`，不是新的 Custom Domain。`api.cinatoken.com/*` 始终由 `cinatoken-proxy` 提供。Admin 的默认 Wrangler 模板不再认领主域名；发布 Admin 时不要设置 `ADMIN_CUSTOM_DOMAIN=cinatoken.com`。

## 发布产物

1. 选用对应提交已通过 Web frontend CI 的 `.release/web/<SHA>` 产物，或运行 `npm run build:web` 后使用 `packages/web/scripts/package-release.mjs` 冻结新版本。禁止直接发布旧 `dist`。
2. 执行 `node packages/web/scripts/package-release.mjs --verify <release-id>`，记录源码提交、manifest SHA、三目标 build contract 与 Worker version。
3. 生成配置时设置 `CINATOKEN_WEB_PUBLIC_ORIGIN=https://cinatoken.com`、`CINATOKEN_WEB_PROXY_ORIGINS=https://api.cinatoken.com`。29 个 `CINATOKEN_WEB_*_ENABLED` 是页面开关；API 与 OIDC 始终转发原始请求至 Admin。
4. 先保持 Web `routes: []`，部署并通过预览/Service Binding 验证。只对临时预览开启 `workers_dev`，正式切流后关闭它。公开 SSR 必须实际经过 Cloudflare；Node 测试不能证明所有 workerd API 可用。
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

回滚只改变页面入口，不回滚数据库或资金状态。尽量保留 Web 前门并关闭页面开关，让旧标签页继续获取 `/web-assets/*`；若恢复整个 Route 至 Admin，仍需将 `/web-assets/*` 路由到已发布 Web，或通知旧标签页刷新。保留冻结产物与原版本至少 14 天。

主实施状态及验收门槛只维护在 [Web 前端迁移 checklist](../../developers/architecture/web-frontend-migration.md)，发布版本与实际结果保存在 `releases/`。
