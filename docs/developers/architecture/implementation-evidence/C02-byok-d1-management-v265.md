# C02 v265：固定 staging D1 管理适配器

2026-09-20，Checklist v1.164。LOCAL_PASS / STAGING_PARTIAL；本轮无云管理调用、部署或原生 BYOK 执行。用户允许独占现有 staging 的授权尚未在云端行使，生产及其他线上资源未改。

## 实现边界

新增 `scripts/deploy/byok-d1-management.mjs`，固定账户及 `cinatoken-staging` UUID，不接受自定义 URL、账户、数据库或任意 SQL。构造器无 I/O；没有命令行执行入口，也不默认读取环境凭据。调用方仍须接入完整候选/代码/隔离/套餐/预算预检守卫，日志中的 preflight ACK 本身不能替代预检。

适配器实现已有围栏下的 56 表基线捕获、控制记录首次 INSERT、围栏首次开放及只封闭、十个用例逐项独立读回、清理许可首次 INSERT。基线复用已有完整列/行摘要验证，私有只读 shim 仅允许固定模块产生的 SELECT 和九张表的 `PRAGMA table_info`，没有暴露通用查询接口。围栏缺失时拒绝，而不是自动安装。

所有 REST 写入均为单条条件 SQL，以 `RETURNING value` 加独立 SELECT 精确读回确认；不把 REST `meta.changes` 当作 SQL `changes()`，也不假定多个 REST 查询具有原生 batch 事务保证。控制和许可期限由 D1 `unixepoch('now')` 生成，分别最长 900 秒和 60 秒。准入检查固定 schema、全表计数、关闭围栏和不存在旧控制/许可；许可检查十个独立 PASS、STOP/封闭 ACK、完整 stopped 控制值、固定 schema、关闭围栏及数据库时钟下不超过五秒的关闭观察。INSERT 不使用 UPSERT/REPLACE，不重置既有记录。

每个步骤先通过已有主机排他日志刷盘 PENDING；本轮增加 `open-fence`、`arm-maintenance`、十个 `verify-case-*` 精确步骤。网络、回执或日志未知均停止普通流程；跨对象也不能重放同一步骤。STOP 回执丢失后，只要独立读到本次 run 已 stopped，仍允许一次封闭，但不重新允许清理。既有保留样本规则不变。

HTTP 固定 Cloudflare HTTPS 端点，禁止重定向，响应至多 2 MiB / 4,096 次读取，请求至多 1 MiB，每次操作最长 60 秒；单调时钟在接受响应的关键点重复检查，防止阻塞事件循环延迟计时器而误接纳过期结果。总调用计数有界；认证、SQL 参数、原始行及远端错误正文不写日志。超时后的迟到响应只取消读取，不能证明远端 SQL 已取消或授权重试。主机局部并发门禁不替代云端 CAS/事务。

## 验证与修正

机器回执：[v265 清单](./C02-byok-d1-management-v265-results.json)。本地 SQLite 使用实际 68 份迁移与现有提案；模拟 REST 对多查询故意不加事务，确保写入路径只依赖单条条件语句。首次测试因 PRAGMA 表名正则未包含数字而误拒 `d1_migrations`：源码/打包各 20 通过、19 失败，没有云调用。该轮源码、构建及结果保留；修正后各 39 项通过，再补单调时限拒绝检查。最终计数见机器回执。

端到端本地验证包括基线 → 控制/围栏 → 十个原处理器用例及主机发送器 → 每例 D1 管理读回 → STOP/封闭 → 清理许可 → 原独立清理接收模块；清除 664 行合成记录，保留 closed 围栏及 finished 许可，其余各表完整行与基线一致。测试还覆盖错误数据库身份、拒绝预检、缺失围栏、响应界限、畸形元数据、数据库漂移、写入已提交后丢 ACK、独立回读不一致、陈旧/未来关闭观察以及未知 STOP 后封闭。

最终源码 **40/40**、打包复测 **40/40**；回归 **432/432**：主机用例 42、日志 18、maintenance 主机调用 22、关闭观察 28、管理传输/时钟 63、gateway 41、清理控制链 72、一次性处理器 29、围栏 36、清理 40、Images SSE 41。staging TypeScript 通过。实际运行是 Windows Node 24.14.1 / SQLite / 合成 HTTP，node22 bundle 目标仅语法兼容；不是原生 Workers Access、D1 事务/并发/到期或 Node 22 执行证明。产品结算代码、Worker 源码与配置未改，未重复 Worker dry-run。

历史 9,820 条普通文件摘要和三条链接记录核验；修改前的主机日志按原字节归档，通过新清单路径映射保留旧证据，不重写旧 manifest，不遍历测试目录的符号链接。实际工作区的 BYOK 执行占位未创建。

## 文档核验与下一顺序

Cloudflare 技能促使区分 REST 与 Worker binding：当前 [D1 REST query](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)给出单查询/`{batch}`请求及 REST changes 元数据含义；[Worker D1 batch 文档](https://developers.cloudflare.com/d1/worker-api/d1-database/)是原生 batch 保证的来源。未将 REST batch 的事务性当作已证明事实。Firecrawl CLI 不可用，回退至官方文档；未采用本地参考文件错误的 session timeout/close 示例。

1. 补齐 17 条围栏安装计划的原生事务执行入口和固定资源部署适配器；不能为接 REST 而悄然改写原生安装合同。
2. 接通 Access/入口启闭、整个状态机及最终独立复核；评估现有 55 次顺序关闭观察的时限，保持两轮观察隔离，不以关闭入口推断 SQL 已静止。未知/失败样本保留，不自动恢复其他实验。
3. 冻结完整操作器后，取得完整当次代码/版本/隔离/实际套餐/预算预检，再在已授权独占阶段执行一次原生验收；独占结束后的受控恢复仍须显式处理常驻围栏和回执。

本轮未重复上轮失败的代码下载，没有新的云状态证明。最后完整观察仍为 v257（2026-09-16T04:43:08.731Z）；v264 的 2026-09-20T14:02:09.808Z 仅为部分观察，完整预检失败结论保留。公开 HTTP 累计 422；本轮模型/KMS 0/0、生产写入 0。首轮累计 US$2 不重置，US$1.20 历史/延迟预留和 US$0.80 未分配预留不变，非实际可用余额，最终账单未确认。C02.G / C01 及其他原生验收门禁继续开放。
