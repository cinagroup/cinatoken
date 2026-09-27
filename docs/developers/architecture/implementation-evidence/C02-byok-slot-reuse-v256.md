# C02 v256：BYOK 槽位复用与 MySQL 管理鉴权绑定修复

日期：2026-09-16。Checklist v1.155。本地实现，未部署；C02.G / C01 保持开放。

## 改动

修复 v255 复现的“100 项 → 删除非尾项 → 新增触发 sort_order=100 CHECK”问题。尾部仍有空位时沿用原序号；尾部为 99 且 live 数小于 100 时，按原 sort_order 顺序压紧为 0…n-1，新项追加到 n。保留现有凭证的相对顺序、fallback/always-use、disabled、allowlist、密文、创建者和时间戳。软删除墓碑、其他 workspace/provider 不修改。100 项上限、运行时最多返回 32 项不变；这不是共享市场总凭证上限。

PostgreSQL/MySQL 在既有 workspace 锁之后，只读并锁定至多 101 个 ID/序号；不加载密文或过滤器用于排序。必要时用 3 条批量更新完成临时 provider 隔离、压紧、恢复，再新增与写审计。所有操作在同一事务中，不做逐项网络更新，不增加外部 API、KMS 或不确定写入重试。

D1 使用单次 5 语句 batch。首条 MATERIALIZED CTE 冻结通过鉴权且满足压紧条件的成员，防止 provider 更新反过来影响同一语句的成员筛选；每项临时 provider 编码旧序号，第二条以此稳定序号排名，不以正在变化的 sort_order 排名。临时命名空间读取使用 workspace/provider 范围索引，避免扫描其他供应商；最后恢复 provider、新增并审计。[D1 batch 原子性](https://developers.cloudflare.com/d1/worker-api/d1-database/)、[SQLite MATERIALIZED](https://www.sqlite.org/lang_with.html)

随机临时命名空间由 Web Crypto UUID 生成，不由请求提供；保持数据库既有长度、字符集和唯一约束。事务失败时临时 provider 不留下残余。没有修改历史迁移或新增产品依赖。

新增 MySQL 精确占位符断言还发现既有四条管理写路径（新增/更新/删除/重排）遗漏了 WHERE 管理 key ID 的绑定：JOIN 与 WHERE 各有一个 ID 占位符，旧代码却删掉第二个值。改为传入完整 predicate 参数；鉴权条件未放宽。门户分支不受此绑定修复影响。[MySQL JSON_TABLE](https://dev.mysql.com/doc/refman/8.4/en/json-table-functions.html)

### D1 到期与零写入的补充修复

探针另确认：管理密钥在 batch 语句之间到期时，旧新增可出现 insert=1、audit=0、返回 null；首版压紧还可能只压紧了序号、后续 insert/audit=0。D1 batch 只在 SQL 错误时回滚，零写入本身不是错误。不是将这类失败归入已通过的故障回滚测试。

最终实现以同一原子 batch 内首条通过完整鉴权的实际写入为授权事实：首次压紧/普通新增/更新/删除/重排仍检查当前密钥有效期；创建只有在紧邻的 provider 恢复确实改动行时才可延续已授权压紧，否则仍须检查有效期。审计要求前一条实际修改恰好 1 行，重排则要求恰好匹配整个集合。只允许该 batch 继续完成，不缓存授权、不跨请求使用，不跳过管理 key ID、状态、owner、workspace 等既有校验。SQL `changes()` 是同连接上一条 DML 的实际计数，不是调用方声称的成功。[SQLite changes 语义](https://www.sqlite.org/lang_corefunc.html#changes)

这也阻止了另一实际复现：满额拒绝新增时，若请求 ID 与旧行相同、时间戳也相同，旧审计查询会误记一次创建成功。现在前序零写入不会生成审计。上述 D1 授权延续与审计变化需要真实 D1 batch 再验收；不把 SQLite 适配器当作云端证明。

## 验证范围与限制

新增测试覆盖首/中/尾空洞、多空洞、全空/只剩尾项、满额拒绝、越权零写入、重复 ID 回滚，以及完整删除→新增→重排→删除→新增。逐列核对原有凭证除 sort_order 外不变，并核对墓碑与其他租户/provider、运行时顺序、密文不进入审计。SQLite 另穷举全部 100 个单项删除位置，并检查两条临时命名空间查询及排名子查询使用 provider 范围索引。

对移出 provider、压紧、恢复 provider、新增及末尾审计五处注入失败，分别验证管理密钥与可信门户 principal 路径的真实 SQLite/PostgreSQL 事务回滚。PostgreSQL 仍使用本地 PostgreSQL 18.3 WASM/PGlite 0.5.8，执行 68 个迁移 SQL，并在三种 search_path 下逐项核对 public/pg_temp 各 25 张同名表未变化。

本轮在 PATH 中未找到 mysql/mysqld/docker 可执行程序，没有运行真实 MySQL 服务。MySQL 测试仅证明 SQL、绑定、批量映射及驱动 commit/rollback/release 调用约定，不证明原生 MySQL SQL 执行、生成列约束或多会话并发。因此槽位缺陷状态为本地已修复、原生验收待完成，不将三引擎全部验收标为通过。

原生 PostgreSQL/MySQL、Cloudflare D1/workerd、Hyperdrive、真实角色/升级、并发撤销/重排和 Workers 容量均仍待验收。本轮不证明门户路由身份重新授权、真实 KMS、Node 22 或远程 CI。

专项到期测试使用合成 SQL 时钟，在真实 SQLite batch 的语句之间推进时间；涵盖三种到期位置 × 压紧创建/普通创建/更新/删除/重排五条路径，并验证零写入旧 ID 不记审计。最初探针相对路径错误、SQLite 自定义 datetime 注册成零参数而未覆盖实际一参数调用，均在执行产品断言前/夹具断言中失败；修正后的探针真实复现，上述两个初始探针源码保留。到期修复前同测试 6 PASS / 10 FAIL，不是云端时钟或并发模拟。

## 结果与归档

最终以 recheck 阶段为准：槽位引擎 143 PASS / 0 FAIL（D1 37 / PostgreSQL 106，含父测试）、MySQL 合同 32 PASS / 0 FAIL、D1 到期/零写入 16 PASS / 0 FAIL。同测试对照：修改前槽位 52 PASS / 91 FAIL、修改前 MySQL 1 PASS / 31 FAIL、到期修复前 6 PASS / 10 FAIL。既有 BYOK 124、其他引擎/合同 448、core 主集 454、SQL 脚本体 184、dispatch 4176、Images SSE 41 均通过，两项类型检查通过。[机器证据](./C02-byok-slot-reuse-v256-results.json)。

首轮新增引擎 138/138、既有 BYOK 回归 124/124，MySQL 合同 12 PASS / 12 FAIL，原因是实际绑定遗漏。第二轮槽位 143/143、MySQL 32/32、BYOK 124/124；第一次完整 final 阶段全部通过，但随后独立到期探针发现更窄套件遗漏的逻辑零写入边界。因此 final 阶段作为中间证据保留，不能代表最终源码；完成到期修复后重新构建并执行 recheck。源码、core bundle、测试和日志均留存。

修改前文件及可执行 BYOK bundle、各阶段输入和日志保留于 `.wrangler/staging/byok-slots-v256`。第一次尝试直接打包归档 TS 因相对依赖路径失效而失败，未生成有效 bundle；随后从尚未修改的原位置成功构建修改前 bundle，保留 esbuild 输入摘要。不把失败构建当作对照结果。

本轮云管理、部署、真实模型/KMS 调用均为 0，生产未操作；首轮累计 US$2 上限不重置，历史云关闭观察未重验。Images 始终保持“有效 completed 图片 + 真实上游 `[DONE]`”不可逆成功点，持久化结算事实先于成功 DONE 交付，后续取消不撤销费用。

复测入口 `test:byok-slots`（须设置本地 GATEWAY_PGLITE_MODULE）包含槽位引擎、MySQL 合同与 D1 到期测试；槽位引擎也纳入 `test:postgres-schema-engine`，MySQL/到期合同纳入 `test:management-keys`。执行的是脚本体而非完整 npm hook 链；重叠套件不可合计为独立覆盖。

下一步补原生 MySQL/D1/PostgreSQL 与并发验收，尤其 D1 同一 batch 的 changes/到期/审计行为；可独立继续其余 PostgreSQL raw SQL schema 限定。真实 Hyperdrive、数据库原生时限、已使用客户端收尾及容量门禁仍开放。云端旧候选不代表本地新源码，部署前必须重新冻结候选并核对隔离和剩余预算。
