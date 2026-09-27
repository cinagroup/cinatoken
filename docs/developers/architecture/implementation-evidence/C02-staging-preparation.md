# C02.B2.2：独立 staging 决定与离线发布准备

2026-09-06。用户明确要求：按 Workers 最佳实践使用独立 staging，并与生产资源隔离。目标仍为 Workers 首发、Node 备选；没有把 Node 样本升级为 Workers 通过证据。

> 本文保留云资源创建前的本地准备证据。后续已确认累计 US$2 上限、创建独立 Worker/D1，并在补齐权限后完成 [8 项受保护基础冒烟](./C02-staging-access-smoke.md)；收尾入口关闭、临时令牌删除。下文“尚未创建”“上限待确认”均为当时状态，整体容量门禁仍未通过。

## 已完成

- 只读确认 Cloudflare 当前账户为 CinaGroup；目标 `cinatoken-proxy-staging`、`cinatoken-staging` 尚不存在。账户已有 Rust staging 与旧 mock upstream，未复用或改动。Access 应用列表可读，但本轮没有创建、编辑或测试任何 Access 策略，不据此宣称写权限已就绪。
- 新增 [staging 独立模板](../../../../packages/proxy/wrangler.staging.base.jsonc) 与 [准备/隔离校验工具](../../../../scripts/deploy/prepare-proxy-staging.mjs)。使用真实代理入口、保留兼容日期/flags；入口关闭、无生产 routes/Cron/Queue/R2/服务绑定；新库 UUID 必须只读核验真实名称才允许注入。
- [3 项专项测试](../../../../scripts/deploy/prepare-proxy-staging.test.mjs) 通过，其中包括 28 种不安全配置变更的拒绝，以及数据库名称/UUID 检查。没有增加测试数量来冒充线上集成。
- 已生成本地 `.wrangler/staging/proxy/wrangler.jsonc`，状态为 `OFFLINE_CONFIG_ONLY_DATABASE_NOT_PROVISIONED`。Cloudflare 尚无对应新 Worker/D1，没有注入秘密。
- Windows 上真实代理代码的 Wrangler 离线打包通过。最终 staging 配置：776 个构建输入，JS 产物 3,736,996 bytes；CLI 报告 3,649.41 KiB / gzip 653.82 KiB；导出 `default` 和 `workerHandler`。外部模块仅观察到 Node 兼容模块与 `cloudflare:sockets`，没有 `@octafuse/*` 未打包依赖。
- 绑定类型生成通过（`--include-runtime=false`），不生成新运行时定义、不启动本地 workerd。准备工具/专项测试语法检查、Proxy 项目类型检查和差异空白检查通过。没有重跑全套业务回归；本轮没有修改业务实现。

## 诊断与验证边界

最初的临时保护器错误地只允许根目录 esbuild，拦截了 Wrangler 实际安装在 pnpm 目录的 esbuild；确认实际文件后才调整白名单。随后受限环境拒绝编译器读取项目路径，经批准在沙箱外重跑离线检查成功。没有用启动失败或保护器失败作为应用测试失败。

打包子进程使用系统路径变量白名单，不继承云凭据或项目 `.env`；关闭遥测和自动资源创建。诊断保护器拦截 Node 网络入口，只允许已确认的 esbuild 子进程；最终成功运行未记录网络拒绝或其他子进程。保护器不是操作系统级网络隔离证明。**成功仅证明当前 Windows 工具链能生成发布包，不能证明 Worker 启动、线上执行、D1 迁移、Access、取消、内存或账务正确。**

首个无 bindings 的离线探针与最终 staging 打包均通过；此处大小只采用最终 staging 配置。生产的所有兼容日期/flags、入口与生成配置均未更改；旧 VC++ 启动故障未经修复，根因仍是强线索而非修复验证结论。

临时产物位于本机临时目录 `cinatoken-workers-dryrun-1ebf2bdce582403e9c7132f5734ac908`，可能被系统清理；正式可复现入口与操作顺序见 [staging 运维说明](../../../operators/deployment/cloudflare-staging.md)。最终打包 SHA-256：`0aefc08ef0512497a860e24e417a98aa2c4f55a03d52439eeb9705c11fab8bd6`。

## 当时的下一步（已由云端记录接续）

### 接续：新库初始化检查

同日继续在不产生云费用的范围内检查 D1 初始化。复用 `node scripts/ci/verify-d1-portal-ledger.mjs`，历史迁移链与所覆盖的账本/预算/归属约束检查通过；该脚本会插入合成用户与账本样本，因此另建纯空库验证，不能以其样本表内容断言 staging 初始数据为空。

Node 24.14.1 / SQLite 3.51.2 内存数据库，以外键开启、每份文件独立事务的方式应用 68 份历史迁移，通过完整性和外键检查。最终 51 张业务表，除 `system_config`（12）、`model_endpoint_backfill_database_identity`（1）、`admin_api_keys`（1）外均为空。

发现 `0002` 的公开演示 Key 经 `0023` 迁入启用状态的 `legacy-master`，`0024` 只删除旧配置项，没有撤销它。新增 [仅 staging 的初始化 SQL](../../../../scripts/deploy/staging-post-migrate.sql)，精确撤销该默认演示 Key；新增 [空库/幂等/轮换保留测试](../../../../scripts/deploy/staging-d1-bootstrap.test.mjs) 2 项，与原 3 项隔离测试合计 5 项通过，语法及差异空白检查通过。没有修改历史生产迁移，也未向任何真实数据库执行 SQL。Proxy 不暴露 Admin 管理路由，不将初始状态问题夸大为当前公开可利用漏洞。

Cloudflare 技能促使本轮按 D1 [迁移](https://developers.cloudflare.com/d1/reference/migrations/) 和 [外键](https://developers.cloudflare.com/d1/sql-api/foreign-keys/) 官方约束区分本地验证与远端门禁。没有重跑 Workers 打包或整个业务套件；上一节打包/类型检查仍为前轮证据。

用户最新授权允许首轮 staging 累计费用超过 US$1，并可调用真实付费模型或 Google Cloud KMS；累计最高金额尚未指定，已询问包含 Cloudflare、模型和 KMS 的总上限。该授权不等于无限额消费，也不扩展至生产资源、自动充值、套餐升级或支付/链上业务。上限确认前不创建计费资源或调用真实付费服务。随后依次核验目标、创建独立 D1/Worker、设置新测试密钥、保护入口，再运行有限线上测试；真实模型/KMS 还需明确测试目标和 staging 专用身份。具体顺序按 [运维说明](../../../operators/deployment/cloudflare-staging.md#3-云端有限顺序)，不再把 Windows 系统修复作为唯一下一行动。

本次授权补充只更新记录，没有重跑历史测试或访问云端。本地生成配置仍为入口关闭、零 routes/cron、数据库名 `cinatoken-staging` 且无数据库 UUID；这不是远端实时资源盘点或部署成功证据。

C00 LOCAL_PASS；C01/C02 DOING；C03–C20 TODO。C02.G 未通过，生产容量策略仍未启用。首发完整运行配置、跨消费者工作集与恢复门禁仍保留。

基线 HEAD 为 `7eb59008f7d8e156e81fd18a57658fdef2553264`；改动既有文件前，前轮 245 文件快照全部匹配。无系统修复、部署、云写入、真实 OAuth/KMS/模型调用、业务数据读取、迁移、支付、远程 CI 或提交。

收尾对照 Proxy 生产模板及 Proxy/Admin/Chain/D1 四份既有生成配置的 SHA-256，5 份均未变化。6 份当前文档的 85 个本地链接目标存在；未据此声称 Markdown 锚点或渲染已验收。
