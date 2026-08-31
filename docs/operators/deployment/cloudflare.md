# 线上部署：Cloudflare（代理服务 Worker + 管理后台 + D1）

本文说明 **cinatoken** 在 Cloudflare 上的运维路径：**本地 D1 开发**、**dev 演示**、**生产 Git 自动部署**。

统一用户/管理员控制台、Chain Worker、Queues、整数账本与生产验收以 [unified-console-production.md](./unified-console-production.md) 为准。

**外部用户首次上云**（推荐）：[cloudflare-quickstart.md](./cloudflare-quickstart.md)（`npm run bootstrap:cloudflare`）。本页不替代该 quickstart。

实例 env 文件约定：[cloudflare-worker/README.md](../../../cloudflare-worker/README.md)。表结构以 **`packages/core/migrations-d1/`** 为准。Docker 自托管见 [docker.md](./docker.md)。

> 本仓库不以 Cloudflare Deploy Button 作为主路径：官方 Deploy Button 无法一次装齐 monorepo 双 Worker + 共享 D1。

---

## 0. 配置模型（必读）

| 文件 | 角色 |
|------|------|
| `packages/*/wrangler.base.jsonc`、`packages/core/wrangler.d1.base.jsonc` | **已提交模板**（无生产 `database_id`） |
| `packages/proxy/wrangler.jsonc`、`packages/admin/wrangler.jsonc`、`packages/core/wrangler.d1.jsonc` | **生成产物**（`npm run gen:wrangler`，gitignore） |
| `cloudflare-worker/example.env` | **dev 演示**配置（可提交） |
| `cloudflare-worker/*.env`（除 example） | **生产/私有**（gitignore）；或仅用 Cloudflare Dashboard **Build variables** |

**两种注入方式（变量名相同）**：

| 方式 | 何时用 |
|------|--------|
| **Cloudflare Build variables** | Workers Builds · `git push` 自动部署 |
| **`dotenv -e cloudflare-worker/xxx.env`** | 本地 CLI：`deploy:*`、`db:migrate:remote` |

`gen-wrangler` 只读 `process.env`，不读 Git 里的 env 文件（CI 构建时 Build variables 即 env）。

---

## 1. 本地 Cloudflare 开发

本机 Worker、不上线；步骤见 [users/quickstart.md](../../users/quickstart.md) §1。远程 deploy 后继续本地 dev 前须 `npm run gen:wrangler`，详见 [local-development.md §1](../../developers/local-development.md#️-本地-d1-与-database_id远程-deploy-后必读)。

---

## 2. dev 演示部署（example.env · 自有域名）

长期公共测试环境，配置见 [`cloudflare-worker/example.env`](../../../cloudflare-worker/example.env)：

| 角色 | 域名 | Worker |
|------|------|--------|
| 代理服务（Proxy） | `https://api.example.com` | `cinatoken-proxy-dev` |
| 管理后台（Admin） | `https://admin.example.com` | `cinatoken-admin-dev` |
| D1 | — | `cinatoken-dev` |

**首次（CLI）**：

```bash
npx wrangler d1 create cinatoken-dev
# 更新 example.env 中 D1_DATABASE_ID
npx dotenv -e ./cloudflare-worker/example.env -- npm run db:migrate:remote
npx dotenv -e ./cloudflare-worker/example.env -- npm run deploy:proxy
npx dotenv -e ./cloudflare-worker/example.env -- npm run deploy:admin
```

dev 演示**仅 CLI 发版**（有新 SQL 时先 `db:migrate:remote`）；生产 Connect to Git 见下方 §4。

下游测试变量：`GATEWAY_URL` / `GATEWAY_MASTER_URL` / `GATEWAY_MASTER_KEY`（见 [integration.md](../../developers/integration.md)）。

---

## 3. 生产部署

**同一仓库代码、多实例**：每个 Worker 一套 **Build variables**；**勿**把生产 `D1_DATABASE_ID` 提交进 Git。

| 场景 | Worker / D1 命名 | 自定义域 |
|------|------------------|----------|
| 默认生产（示例） | `cinatoken-proxy` / `-admin`，D1 `cinatoken` | 常见为 Cloudflare Dashboard 绑定，wrangler 不写 `routes` |
| dev 演示 | `*-dev`，D1 `cinatoken-dev` | 替换为自有测试域名（见 `example.env`） |
| 自有 fork / 第二实例 | 自定 Worker 名与 D1 名，避免与同账号其它实例冲突 | 可选 `PROXY_CUSTOM_DOMAIN` / `ADMIN_CUSTOM_DOMAIN` |

本地 CLI：复制 [`example.env`](../../../cloudflare-worker/example.env) 为 gitignore 的 `cloudflare-worker/<name>.env`，填生产值后 `dotenv -e ... deploy:*`（与 Build variables 同名同值）。首次也可直接用 [cloudflare-quickstart.md](./cloudflare-quickstart.md)。

### 环境变量（Build variables / 本地 `.env`）

| 变量 | 说明 |
|------|------|
| `PROXY_WORKER_NAME` / `ADMIN_WORKER_NAME` / `CHAIN_WORKER_NAME` | **须与 Cloudflare Dashboard 中的 Worker 名一致** |
| `CHAIN_JOB_QUEUE_NAME` / `CHAIN_JOB_DLQ_NAME` | 链上任务 Queue 与死信 Queue；每个实例必须独立 |
| `CINACHAIN_CHAIN_ID` | 钱包签名与 Chain Worker 必须使用同一链 ID |
| `D1_DATABASE_NAME` | D1 逻辑名 |
| `D1_DATABASE_ID` | 远程 deploy / migrate **必填**。写入生成的 `wrangler.jsonc` 后，本机 `dev:proxy`/`dev:admin` 会连**另一套**本地 D1；继续本地开发前执行 `npm run gen:wrangler`（见 [local-development.md §1](../../developers/local-development.md#️-本地-d1-与-database_id远程-deploy-后必读)） |
| `D1_MIGRATIONS_WORKER_NAME` | 可选；仅 `wrangler d1 migrations` 配置名，**无需建 Worker** |
| `HYPERDRIVE_ID` | 可选；把同一个 Hyperdrive 绑定加入 Proxy、Admin/Portal、Chain Worker。仅设置此项不会切库 |
| `DATABASE_DRIVER` | Cloudflare 省略/`d1` → D1；`postgres` → Hyperdrive。选择 Postgres 时 `HYPERDRIVE_ID` 必填；三个 Worker 必须一致 |
| `REQUEST_BODY_LOGGING` | Proxy 请求正文日志策略；模板默认 `off`。仅经隐私与留存评审后可设为 `redacted`，且脱敏结果仍可能包含敏感提示词 |
| `PROXY_CUSTOM_DOMAIN` / `ADMIN_CUSTOM_DOMAIN` | 可选 |

---

## 4. Workers Builds（Connect to Git）

Cloudflare Dashboard → Worker → **设置（Settings）→ 构建（Builds）**。Worker 名须与 `PROXY_WORKER_NAME` / `ADMIN_WORKER_NAME` 一致（[Workers name requirement](https://developers.cloudflare.com/workers/ci-cd/builds/troubleshoot/#workers-name-requirement)）。代理服务与管理后台 **各绑一次**。

### Cloudflare Dashboard 通用设置

| 项 | 值 |
|----|-----|
| **Root directory** | **留空**（monorepo 根；`npm ci` / `gen:wrangler` 必须在仓库根执行） |
| **非生产分支构建** | 按需勾选 |

### Build variables

在 **Build variables** 填入 §3 上表变量（代理服务 / 管理后台两个 Worker 各配一套；`D1_DATABASE_ID` 两边相同）。**生产 UUID 只放 Cloudflare Dashboard，不进 Git。**

| 变量 | 必填 | 说明 |
|------|------|------|
| `PROXY_WORKER_NAME` | 代理服务 Worker | 须与 Cloudflare Dashboard Worker 名一致 |
| `ADMIN_WORKER_NAME` | 管理后台 Worker | 同上 |
| `D1_DATABASE_NAME` | ✅ | D1 逻辑名 |
| `D1_DATABASE_ID` | ✅ | `npx wrangler d1 list`；**只放 Cloudflare Dashboard** |
| `D1_MIGRATIONS_WORKER_NAME` | 可选 | 仅迁移脚本配置名 |
| `HYPERDRIVE_ID` | PG 灰度时必填 | `npx wrangler hyperdrive list`；三个 Worker 使用同一个配置 ID |
| `DATABASE_DRIVER` | PG 切换时必填 | 先预置 `HYPERDRIVE_ID`，完成迁移/对账/隔离探针后才设为 `postgres` |
| `PROXY_CUSTOM_DOMAIN` / `ADMIN_CUSTOM_DOMAIN` | 可选 | 写入 wrangler `routes` |

### 构建 / 部署命令

**勿**在 Deploy 填 `npm run deploy:proxy` / `npm run deploy:admin`——CI 已拆分 build 与 deploy；Deploy 再跑 `deploy:*` 会重复生成配置。

| Worker | Build command | Deploy command |
|--------|---------------|----------------|
| **代理服务** | `npm ci && npm run gen:wrangler` | `npm run deploy -w @octafuse/proxy` |
| **管理后台** | `npm ci && npm run gen:wrangler && npm run build:cf -w @octafuse/admin` | `cd packages/admin && npx opennextjs-cloudflare deploy` |

说明：

- `npm ci` → `postinstall` → `gen:wrangler` 会读 **Build variables** 生成 `wrangler.jsonc`。
- **D1 迁移不在 Git 流水线**：有新 SQL 时手动 `npm run db:migrate:remote`（带实例 env 或 export 变量）后再 push。
- **PostgreSQL 迁移也不在 Worker 部署流水线**：通过受控迁移 Job 注入 `DATABASE_URL` 执行 `npm run db:migrate:pg`；Worker 本身只接收 Hyperdrive 绑定，连接串不进入 Build variables。
- **统一控制台**：使用 CinaAuth；必需 Secret 与隔离的 Chain Worker Secret 见生产 runbook，Cloudflare 生产不再使用 `ADMIN_PASSWORD` 登录。
- 可选：`WRANGLER_SEND_METRICS=false`。

### Build watch paths（减少无关 push 触发部署）

Cloudflare Dashboard → **设置 → 构建 → Build watch paths**。默认 `includes: *` 表示**任意文件变更都会构建**；本仓为 monorepo，建议为 **代理服务 / 管理后台分别配置**，Exclude 留空。

判定规则（[Build watch paths](https://developers.cloudflare.com/workers/ci-cd/builds/build-watch-paths/)）：先匹配 **Exclude**，再匹配 **Include**；push 中任一变更路径命中 Include 则构建，否则跳过。

**代理服务 — Include**（一行粘贴）：

```
packages/proxy/*, packages/core/*, scripts/deploy/*, package.json, package-lock.json
```

**管理后台 — Include**：

```
packages/admin/*, packages/core/*, scripts/deploy/*, package.json, package-lock.json
```

说明：

- 改 **`packages/core`** 或根 **`package.json` / `package-lock.json`** 时两个 Worker 都会构建。
- 仅改 **`packages/proxy`** → 只构建代理服务；仅改 **`packages/admin`** → 只构建管理后台。
- **`docs/`、`docker/`、`examples/`** 等不在 Include 内 → **不会**触发 Worker 构建。
- 改 **`packages/core/migrations-d1/`** 会触发构建，但 **不会**自动跑迁移；仍需本地 `db:migrate:remote`。
- 需要强制全量构建时：Cloudflare Dashboard 手动 **Retry deployment**，或 push 空 commit。

### 本地 CLI（与 CI 相同生成逻辑）

```bash
npm run deploy:cloudflare -- <instance> --migrate   # 推荐
# 或手动：
npx dotenv -e ./cloudflare-worker/<instance>.env -- npm run gen:wrangler -- --remote
npx dotenv -e ./cloudflare-worker/<instance>.env -- npm run db:migrate:remote
npx dotenv -e ./cloudflare-worker/<instance>.env -- npm run deploy:proxy
npx dotenv -e ./cloudflare-worker/<instance>.env -- npm run deploy:admin
```

---

## 5. 首次创建 D1

```bash
npx wrangler login
npx wrangler d1 create cinatoken-dev   # 或你的生产 D1 名
npx wrangler d1 list
```

将 **`D1_DATABASE_ID`** 写入 Build variables 或 gitignore 的 `cloudflare-worker/<name>.env`。外部首次上云优先用 [cloudflare-quickstart.md](./cloudflare-quickstart.md)（脚本会创建或复用 D1）。

---

## 6. 迁移与发布顺序

1. 有待执行迁移：`npx dotenv -e ./cloudflare-worker/<x>.env -- npm run db:migrate:remote`
2. 先部署 Chain consumer，再部署 Proxy 与统一控制台；推荐使用 `npm run deploy:cloudflare -- <instance> --migrate`

先迁移、再发依赖新 schema 的 Worker。

### 公开模型统计（0034）

- D1/PostgreSQL 的 `0034_public_model_daily_stats.sql`（MySQL 为 `0030`）建立 16 分片的按模型日汇总，并一次性回填最近 90 天；生产升级必须先完成该迁移，再部署读取新表的 Proxy。
- Proxy 的 Wrangler 模板声明 `PUBLIC_STATS_RATE_LIMITER`（namespace `2002`，每个数据中心每分钟 12 次缓存未命中）。此 binding 由 `npm run gen:wrangler` 生成，不是 Secret，也无需额外环境变量。
- `GET /catalog/stats/models` 的正常响应使用 60 秒 Cache API TTL。缓存不可用时仍只查询有界汇总表；限流 binding 存在但调用失败时接口安全返回 `503`。
- 发布后用连续两次相同 `range` 请求检查 `X-CinaToken-Cache: MISS` → `HIT`；再确认查询计划只访问 `public_model_daily_stats`，不访问 `api_key_request_logs`。
- **0034 首次上线必须冻结旧写入**：先以 `CINATOKEN_MAINTENANCE_MODE=true` 发布 Proxy 并确认外部请求返回维护状态，再执行迁移和发布新 Proxy，最后关闭维护模式。不得直接用未冻结写入的“迁移后再部署”窗口，否则旧版本在两步之间写入的请求不会进入日汇总。Node/Docker 部署对应为摘流量/停旧进程、迁移、启动新镜像后恢复流量。
- D1→PostgreSQL 切换会把 `public_model_daily_stats` 与请求日志一起置于冻结快照中 ETL，并核对行数及六个累计字段；源端和目标端都必须达到 `0034` 才允许切换。

### 请求预设（0035）

- D1/PostgreSQL 的 `0035_request_presets.sql`（MySQL 为 `0031`）创建 `request_presets` 与 `request_preset_versions`；必须先迁移，再发布读取 `requestPresets` 仓储的 Proxy/Admin。
- D1→PostgreSQL ETL 顺序包含 Preset 主表与版本表，且两端切换门禁必须达到 `0035_request_presets.sql`。
- 发布后用普通用户创建一个私有 Preset，创建第二版本并回滚，再用另一个用户确认私有 slug 返回 `gateway.preset_not_found`；最后由管理员核对所有者、指定版本与归档状态。

### Guardrails 与路由数据策略（0036–0037、0046）

- D1 必须迁移到 `0049_model_endpoint_audio_capabilities.sql`，PostgreSQL 到 `0048_model_endpoint_audio_capabilities.sql`，MySQL 到 `0045_model_endpoint_audio_capabilities.sql`。前一组迁移已为每条 Endpoint/Route 绑定增加 nullable subject fingerprint；本组为 Endpoint 增加 operation-scoped `audio_capabilities`。旧链接保持 `NULL`、旧音频证据保持 `{}`，不得从 legacy pricing 自动猜测回填。D1/PostgreSQL 版本号相差一是因为 D1 独有 `0041_user_budget_spent_micros.sql`，不得按相同序号判断等价。
- 必须先迁移，再发布读取 `guardrails` / `routeDataPolicies` 仓储的 Proxy 和 Admin。旧 Worker 与新表结构混跑会使所有带策略请求进入 500，而不是安全降级。
- 新 route target 默认数据策略是 `unknown`、允许训练、无 ZDR；这是有意的 fail-closed 默认。管理员需在 `/admin/data-policies` 附上公开 HTTPS 证据和有效期后，ZDR 流量才会进入该路由。
- subject 绑定迁移会把所有旧 `verified` 断言置为 `unknown` 并写入 `subject_fingerprint_backfill_required` 审计；这是安全升级行为。迁移后必须由管理员逐条复核并重新保存，不能批量复制旧状态。Route 的 Provider/模型/协议/operation/adapter/`custom_params`，或 Provider 的 endpoint/API Key/共享渠道发生变更时，断言会自动失效；运行时 fingerprint 比较是最终 fail-closed 门禁。
- 发布后最小验收：管理员下发一个用户绑定并确认普通用户无法覆盖/解绑；构造 `provider.zdr=true` 请求确认仅命中已核验 route；将证据设为过期后确认返回 `gateway.zdr_no_route`；检查审计快照与请求审计均不含原始提示词、上游 Key 或合同内容。

---

## 7. 认证与下游

- 管理 API 使用后台创建的具名 Admin API Key，并按资源权限授权（见 [api/admin.md](../../developers/api/admin.md)）。
- 下游门户：`GATEWAY_URL`（代理服务）、`GATEWAY_MASTER_URL`（管理后台）、`GATEWAY_MASTER_KEY`（见 [integration.md](../../developers/integration.md)）。

---

## 8. 健康检查

- 代理服务：`GET /health`
- 管理后台：首页、数据库 Session 登录，以及携带具名 Admin API Key（含 `config.read`）的 `GET /api/admin/config`
- D1 迁移：`npx wrangler d1 execute <name> --remote --config packages/core/wrangler.d1.jsonc --command 'SELECT COUNT(*) AS applied FROM d1_migrations;'`
- 日志：`npx wrangler tail`（Worker 名见 Build variables）

### Workers Free 的 3 MiB 体积限制

Cloudflare Workers Free 的单 Worker gzip 上限为 **3 MiB**。管理后台依赖 **`@opennextjs/cloudflare@1.19.4+`**（未使用 `ImageResponse` / `opengraph-image` 时不再误打包 `@vercel/og` / `resvg.wasm`）。部署输出的 `Total Upload ... gzip` 应低于套餐上限。若仍超限，检查是否误引入 OG 路由或过大依赖。若免费额度余量吃紧或流量上来，也推荐升级 [Workers Paid](https://developers.cloudflare.com/workers/platform/pricing/)（约 $5/月）——量大管饱，性价比极高。

管理后台的 `wrangler.base.jsonc` 设置了 **`NEXT_PRIVATE_MINIMAL_MODE=1`**：本应用无 Next `middleware.ts`，用以避开 Workerd 上 `getMiddlewareManifest()` 动态 `require` 导致的全站 500（上游 [opennextjs-cloudflare#1232](https://github.com/opennextjs/opennextjs-cloudflare/issues/1232)）。若日后引入 middleware，需等上游正式修复后再去掉该变量。

---

## 9. 多实例与灰度

同一 Cloudflare 账号可跑多套 Worker（不同 `PROXY_WORKER_NAME` / `D1_DATABASE_ID`）。升级 **gen-wrangler** 或迁移流程时，建议：

1. 先在 **dev 演示**（`example.env` + CLI 发版）或 staging 验证变更。
2. 再更新生产 Worker 的 Build variables；必要时对生产 Worker **Pause Builds**，配好变量后再恢复。
3. 有新 D1 SQL：**先** `db:migrate:remote`（对应实例 env），**再**部署依赖新 schema 的 Worker。

### 回滚

Workers Builds 部署历史 **Rollback**；或 Pause Builds 后回滚版本。

---

## 10. 下游 fork

若维护独立部署 fork，生产绑定（`D1_DATABASE_ID`、Worker 名、域名）应放在各 fork 的 **Build variables** 或 gitignore env 中，**勿**在 Git 里提交真实 `wrangler.jsonc`。merge upstream 时无需保留旧的 committed `database_id`。

---

**相关**：[cloudflare-worker/README.md](../../../cloudflare-worker/README.md) · [部署索引](./README.md) · [local-development.md](../../developers/local-development.md)
