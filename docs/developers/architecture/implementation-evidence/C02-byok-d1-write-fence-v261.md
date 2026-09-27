# C02 v261：BYOK staging 持久写入围栏

2026-09-16，Checklist v1.160。**本地写入围栏与原子清理验证通过；尚未安装到云端，也没有完成原生 D1 验收。** 本轮修改 staging 清理辅助模块、新增 SQL 构建器和测试；未改变产品 SQL、生产运行代码、已部署入口或云配置。

## 补上的边界

仅观察入口关闭、控制记录 STOPPED 或本机 active=0，不能证明已提交给数据库的迟到工作已经消失。`byok-d1-write-fence.ts` 增加 15 个 staging 专用 BEFORE 触发器，覆盖 `users`、`workspaces`、`management_api_keys`、`byok_keys`、`user_audit_logs` 的 INSERT / UPDATE / DELETE；许可保存在一个常驻 `system_config` 标记中。

- INSERT / UPDATE 必须同时满足：标记 open、当前 run ID 一致、控制记录 pending、cursor 与用例匹配、数据库时钟仍在许可窗口内、目标属于当前用例。UPDATE 同时检查旧行与新行，不能换所有者逃逸。closed、过期、缺失或所测损坏控制一律拒绝相关行写入。
- 正常 DELETE 始终拒绝。通过完整清理校验后，清理事务内部将标记从 closed 改为 cleaning，仅允许当前 run 的明确用例归属；六条精确 ID 删除后，在同一事务内恢复 closed。两次标记修改各有 `changes()=1` 守卫。
- 触发器只做 SELECT / RAISE，不额外修改产品行。原生 D1 必须使用一个 `batch()` 事务，不得把打开标记、删除和关闭拆成独立请求。D1 文档说明任一批次语句出错会回滚整个序列；这里的实测仍是本地 SQLite。[D1 batch 合同](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- 清理后保留 15 个触发器和 closed 标记。删除保护对象会使迟到语句重新可执行，因此没有自动卸载、重开或重放接口；旧 run 不能借用新 run 的许可。
- audit-rollback 用例唯一的故意不存在 actor 仍让原来的外键约束拒绝，不用围栏错误冒充产品回滚证据。SQLite 的触发器 `changes()` 保存/恢复语义作为设计依据，十用例的本地批次回执也与无围栏对照一致；原生 D1 元数据仍须验证。[SQLite changes](https://www.sqlite.org/c3ref/changes.html)、[RAISE / trigger](https://sqlite.org/lang_createtrigger.html)

## 清理与基线

`captureByokD1CleanupBaseline(..., 'write-fence-v1')` 显式选择保护模式；必须在 arming 前捕获。该模式核对完整 schema 摘要、15 个触发器的精确 SQL，以及常驻标记的关闭值和描述。旧模式保持兼容，但保护模式不能降级成旧模式：`system_config` 基线计数不同会拒绝。

十用例完整清理：**143 条事务语句，842910 字节序列化计划，664 条合成记录移除**；含清理控制记录，不含常驻围栏标记。56 表的完整行、计数和 schema 前后守卫不变。提交失败回滚所有删除及许可状态；提交 ACK 丢失保留 ATTENTION_REQUIRED，不再次执行或宣称已确认清理。STOPPED 但仍 pending / failed 的用例继续隔离，即使围栏已经关闭也不授权删除。

本地原始 schema 为 292 个对象；安装围栏后是 **307 个对象，system_config 从 12 增至 13**。这不是当前云端状态：最后观察的云端基线仍为 295 个对象 / 12 条配置。将来安装后须重新读取并冻结实际云端基线，不能用本地摘要、推算对象数或旧 baseline 替代。

安装构建器只返回 17 条原子语句：原 schema / 五个样本表为空 / 控制标记缺失的守卫、15 个 CREATE TRIGGER 和一个关闭标记 INSERT。没有自动 I/O 或 IF NOT EXISTS。**完整 56 表原始基线、绑定身份、独占、入口隔离及预算预检仍由尚未接通的可信操作器负责。** 这不是一键安装器或已授权线上命令。

## 适用范围与限制

这些触发器约束五张表的全部行，不是仅按名称前缀拦截，因此闭锁期间其他 staging 工作负载也不能写这些表。该数据库必须暂时专用于本轮 BYOK 验收；不能在已有 Images/其他实验仍使用它时安装。后续实验如要恢复这些表的通用写入，必须先完成独立停写/生命周期审计，另行设计显式切换；本轮不提供快捷删除围栏的操作。没有修改生产数据库或生产迁移。

围栏依赖数据库事务串行化和未被篡改的触发器 / 配置。具有 DDL 或修改 `system_config` 权限的操作者可以绕过它；不是恶意管理员防护、全部调用入口枚举或数据库全局静止证明。新增触发器会改变 staging schema、读成本和耗时；**产品 SQL 文本 / 批次不变，不等于无围栏生产容量等价**。

现有 recovery-control 仍没有 D1，usage-recovery 仍有固定 staging `RECOVERY_DB`。下一步通过既有受保护 service binding 接原生清理通路，不能传入任意数据库，也不能以 Worker 调用管理 REST 替代 D1 binding。依据 Workers 技能，本轮保持无新 HTTP 入口、无新绑定、无自动安装。[Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)

## 验证材料

- 新增 **36/36**：源码和 browser ESM bundle 各执行一遍，包括四种完成前缀、安装原子性/重复安装、缺失/篡改 schema、关闭/过期/错 run/错用例、迟到和拒绝后再执行、原约束错误、完整产品批次对照、清理回滚/ACK 丢失及新 run 隔离。
- 其中两项使用同一本地 WAL 数据库的两个真实 SQLite 连接：清理事务期间外部连接始终只能读到 closed 和原行；第二写入受锁限制；提交或回滚后，之前 prepare 的迟到 INSERT 仍被围栏拒绝。保留纯合成数据库文件。**不是原生 D1 多请求并发证据。**
- 既有旧模式清理 **40/40**、一次性处理器 **29/29**、验收程序 **19/19**、BYOK **204/204**、Images SSE **41/41**；staging 类型检查通过。套件重叠不汇总为独立功能数量。未重跑完整 dispatch/npm hook 链、主机操作器或远程 CI，未验证 Node 22。
- 首次双连接测试有一个 ESM 导入别名拼写错误，修正后重跑；不是数据库隔离失败。诊断笔记保留。
- 7,407 条历史摘要按修改前归档重新核验；旧清理源码映射到独立归档，旧 manifest 不改写。新结果记录两份 bundle、源码依赖、日志及合成本地数据库摘要。

复测：`node .wrangler/staging/verify-byok-fence-v261.mjs local-<新标签>`，输出目录必须尚不存在。[机器证据](./C02-byok-d1-write-fence-v261-results.json)

## 后续有限顺序

1. 接好独立、受保护、固定 staging binding 的控制/清理入口；将围栏安装、封闭确认、完整基线、一次性授权和请求生命周期接入主机独占日志。未知执行继续隔离，关闭入口不直接授权删除。
2. 冻结新入口、配置、生成类型与构建；验证既有套餐下完整请求 SQL/触发器读成本和执行上限，明确 BYOK 专用期间及新基线。重新核验 US$2 累计预算，不自动升级或创建新云资源。
3. 完成当次隔离预检后才进行一次原生用例/清理验证，留存失败与未知结果；原生 D1 `changes()`、约束回滚、并发、中途到期和实际费用仍不得用本地结果替代。

本轮云管理 / 公开 HTTP、部署、模型 / KMS、生产写入均 **0**。最后云观察仍为 v257 的 **2026-09-16T04:43:08.731Z**，公开 HTTP 累计 422，本轮未重验。首轮累计 **US$2 不重置**；历史/延迟预留 US$1.20、未分配预留 US$0.80 不变，不代表实际余额，最终增量账单仍未确认。Images 不可逆成功点不变；C02.G / C01、真实 MySQL/PostgreSQL/Hyperdrive 和 Workers 容量继续开放。
