# C03 v299：默认禁用的驱动候选与实际构建入口

2026-09-21；**LOCAL BUILD / NODE WIRE PASS，生产未采用，C03 DOING**。

C01.3 已在 [ADR-0002](../decisions/ADR-0002-request-execution-settlement-states.md)接受；本轮不新增 unknown 收费政策、推理重发许可或云端权限。承接 [v298](./C03-postgres-driver-reservation-v298.md)，将已验证的事务退役、BEGIN reservation 和迟到 drain 候选带入应用构建路径。构建通过不解除任何原生 PostgreSQL、Workers、Hyperdrive、资金或资源门禁。

## 1. 实际完成

- 新增 `scripts/db/diag/postgres-candidate-adoption.mjs`：默认 `enabled=false` 返回空插件列表，不读取环境变量开启，也不修改依赖、安装脚本或生产配置。显式选择 Node / Workers 才生成 v298 相同的版本 / 源码摘要限定候选；不复制第二份补丁算法。
- 显式采用的构建必须产生 metafile。审计拒绝缺失候选、错误分支、候选被消除、残留裸 `postgres` / PostgreSQL Drizzle adapter 外部导入，以及同包未修补源文件。未知 subpath 和缺失审计直接失败。候选文件加载前再校验产物 SHA-256。
- Node 采用入口同时打包 `drizzle-orm/postgres-js`：该 adapter 自己导入 `postgres` 并支持由连接串建客户端；仅替换应用的直接导入会留下这一已知间接构造路径。其他无关依赖仍沿用原构建方式。这不是任意外部依赖闭包的通用安全审计。
- `packages/proxy/scripts/build.mjs` 导出实际 build options 与 workspace 外部引用检查，并增加 CLI 主入口 guard；导入它不再自动构建。CLI 默认路径、解析和外部化规则不变，独立旧配置 oracle 与新默认产物逐字节一致。测试插件排在普通外部化之前；倒置顺序的真实构建被拒绝。
- 验证两种完整 Node proxy 路径：现有 package exports 确实使用 `core/dist/index.js`；另一次只在 scratch 构建中将 core 根导入指向本轮新建 core bundle，证明新源码可以沿两阶段构建进入完整 proxy。没有覆盖共享 dist，也没有把旧 dist 的测试宣称为新源码全链路验收。
- 实际 `createPostgresDatabaseClient()` 的导出 bundle 经过真实 postgres.js loopback 运行 26 项事务用例；不是绕过工厂直接 new driver。夹具逐次确认唯一、准确的 `SET search_path` 和非事务状态，然后独立保留 initialization trace，再检查业务 trace。异步工厂 await 之前即登记 teardown。
- 真实 Wrangler 4.127.1 执行完整 `packages/proxy/src/index.ts` 的 `deploy --dry-run`，通过显式 alias 消费 CF 候选。配置只镜像 main、compatibility_date/flags，无账户、路由、资源绑定或 build hook；测试校验字段白名单、生产兼容设置一致、实际入口及产物依赖图。配置仅用于构建，不能用作可运行的 staging 配置。
- Wrangler 子进程只继承 OS 必需环境，显式空 env 文件，工作区内日志 / XDG 目录，关闭 metrics，并预加载 JS socket/TLS/HTTP/fetch 拒绝护栏。四轮均输出 `No bindings found` 和 dry-run 退出；未调用应用、未部署、未连接任何数据库或模型。

## 2. 本轮结果与未隐藏的失败

| 检查 | 结果 | 解释 |
| --- | --- | --- |
| 最终采用 harness | **9/9**，14509.6039 ms | 包含父级测试；不可与其内嵌 wire 数字直接相加当作独立场景 |
| 实际 core 工厂事务 wire | **26/26**，3580.77 ms | 原三项跨文件重复，23 种事务场景；每项新增工厂 session 初始化检查 |
| 实际 core 初始化 wire | **7/7**，5045.0833 ms | database/context/worker 工厂失败与断连各一项及成功关闭；仍在 Node 上运行 |
| v298 候选完整回归 harness | **5/5**，6143.8722 ms | ESM/CJS 各 26/26；双构建相同；hook-only 双分支各 0/1 为预期负对照 |
| owner + PGlite runner | **35/35**，14686.267 ms | 没有原生多连接 / WAL / pooler 证据 |
| 未修补安装驱动 | **2 PASS / 1 FAIL**，730.3717 ms | `nextWrite` 空 socket 异常仍可复现；不隐藏为通过 |
| runner 定向 TypeScript、4 个 JS 语法检查、build diff whitespace | **PASS** | 未宣称仓库整体 typecheck 通过 |
| Workers 执行 / 原生 PG / 真实模型 / KMS | **0 次** | Wrangler 成功仅是完整入口打包，不是运行时验收 |

首轮 harness 为 4 PASS / 3 FAIL（含父级失败），不是驱动新的运行时反例：

1. Windows 生成 wrapper 使用 `C:/...` 裸绝对导入，Node 要求 file URL；两文件均在模块加载阶段失败，**0 项事务用例实际执行**。改用 `pathToFileURL` 后运行全部用例。
2. Wrangler 构建已成功，但审计用 cwd 解析 metafile。它实际相对配置文件目录；改正基准目录，不删除“必须消费指定候选”的断言。
3. 首次 `wrangler --version` 打印 4.127.1，同时尝试写用户目录日志被 sandbox 拒绝。后续日志仅写 scratch 目录；没有提权或扩大文件权限。

保留所有阶段产物 / 结果：首轮 `postgres-adoption-v299-5fizx6`；修正接线后 `...-WVRlc8` 为 7/7（尚未封闭 Drizzle 间接导入）；补 adapter / 分支负例后 `...-fNOteG` 为 8/8；加入 fresh-core 两阶段样本后最终 `...-FQqOzE` 为 9/9。它们是顺序演进，不能把中间轮替代最终代码验收。未删除任何失败证据。

## 3. 产物与复跑

机器摘要：[v299-results.json](./C03-postgres-candidate-adoption-v299-results.json)。完整 input hash、metafile、子进程 TAP 与 Wrangler 输出在 `.wrangler/staging/postgres-adoption-v299-FQqOzE/`。当前默认输入包含的 core dist 摘要为 `9f585cda9e7266c78dcc15f5f8157c4467a3caeaf6f67ac0baa8b8f3d06e1bc8`，未覆盖。

| 最终产物 | SHA-256 |
| --- | --- |
| core baseline = disabled | `8db61255e8ec2be3a88c327c17be74d881160d53ac0c9c13449726fd362dfabe` |
| core enabled = repeated | `8cdc42bbb6562817667d9bc26ba4799e1ff446f81c924a9855bba2ad34874caf` |
| proxy 默认 = 旧配置 oracle | `b3d9e0c5ec65debb1737a25abee931d1d56838db930feeb8d9146e1ecf703825` |
| proxy 显式候选 / 已有 core dist | `6f0b73219c02635e2f1f26ac2ea19025b10e4cf96c143b73a55194bd674408f7` |
| proxy 显式候选 / fresh scratch core | `63167a9681d44487311261891aba5035e7da2986f7833e93b6743a361da8955d` |
| Wrangler 完整入口 CF 候选 | `1b5ee18632cb953ab270751e1d948cf5952c95207127068384094f77e937e1d6` |

Node 候选虚拟模块使用稳定标识；Workers sourcemap / source comments 包含 scratch 路径，本轮不声称不同目录下完整 Worker 字节可复现。v298 三分支底层候选摘要仍分别为 `9bdf3525…a0c2b` / `c828cc2d…1f38e` / `16907dac…ba47e`，未改算法。

仅本地复跑（不运行 npm prebuild / postinstall，不覆盖 dist）：

```powershell
node --test --test-reporter=tap scripts/db/diag/postgres-candidate-adoption.test.mjs
node --test --test-reporter=tap scripts/db/diag/postgres-transaction-retirement.test.mjs
node node_modules/typescript/bin/tsc -p packages/core/tsconfig.recovery-runner-postgres.json --noEmit
```

版本：Node 24.14.1、postgres.js 3.4.9、esbuild 0.27.3、Drizzle 0.45.2、Wrangler 4.127.1。测试 before/after 核验 13 个关键文件（两份锁、依赖包元数据、六份驱动源、core/proxy package、现有 core dist、生产 Wrangler 配置）。生成文件全部是可复跑的工作区诊断产物，未覆盖用户资料。

## 4. 门禁和下一有限工作包

**本轮不是生产依赖采用批准，也不将 C03 标 DONE。** 没有启用 PostgreSQL recovery factory / scheduler，原安装驱动缺陷继续存在。ESM/CJS/CF 打包、Node loopback、PGlite 分别只证明各自层次；不证明真实 PostgreSQL 执行取消、锁等待、最小角色、Hyperdrive 事务池或 Workers socket 生命周期。依照 [Cloudflare 测试建议](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)，Node 通过不能替代 Workers 内运行；[Wrangler dry-run](https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy)不执行部署。[esbuild 插件顺序](https://esbuild.github.io/plugins/#on-resolve)及本地实测共同约束候选必须先于通用外部化。

下一有限工作包：先补**正常 COMMIT/ROLLBACK 完成后逃逸的 tx 句柄**及**同步 socket.write 异常**两类剩余驱动归属反例和受限候选测试，再扩展完整 DB 操作执行时限 / 未确认清理合同。不要用关闭共享 pool、Promise.race 超时或已完成结算冒充资源释放。原生 Windows 运行库更新许可未到位，不重试 initdb、不安装 / 重启、不替换远端测试环境。无损日志、权限、迁移 / 保留期、C01 未决政策和 C02.G 隔离条件均保留。

本轮云管理 API、远端 SQL、部署、真实模型 / KMS、资源创建与删除均为 **0**。首轮累计 **US$2** 上限不重置。
