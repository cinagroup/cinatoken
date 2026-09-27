# C02 v250：ORM 与用户预算预留 schema 限定（首个切片）

日期：2026-09-16。结果：LOCAL_PASS / 整体 STAGING_PARTIAL，未部署，C02.G 未通过。

## 改动

46 个 PostgreSQL ORM 表改用迁移所属 `cinatoken_gateway` schema；用户预算预留仓储的 9 处原始 SQL 同步限定 schema。验证脚本将新旧源码进行机械变换对照，确保没有改字段、约束、预算状态、金额或重试逻辑。保留原有 session 设置，未修改 D1/MySQL、历史迁移或 Images 成功点。

这不是完整 Hyperdrive 修复。剩余财务 raw SQL、混合驱动模板及服务端函数必须继续覆盖；[合同与后续顺序](../../reference/postgres-schema-policy.md) 明确列出范围。Workers 与 PostgreSQL 最佳实践促使本轮采用显式表定位，不以单连接或长事务维持会话设置。[Hyperdrive 官方说明](https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/#pooling-mode)

## 验证结果

| 验证 | 结果 | 范围 |
|---|---:|---|
| 新增 ORM SQL 合同 | 47/47 | 46 表 CRUD、外键、自连接及导出清单 |
| PGlite SQL 引擎对照 | 修改前 0/70；修改后 70/70 | 68 个子测试 + 2 个父测试；同一最终测试源码 |
| Core 单测主集 | 454/454 | 含新增 47 项，不是全部 npm pre/post 钩子链 |
| Core SQL 相关回归 | 136/136 | ordinary-budget、workspaces、management-keys、batches、model-endpoints 的脚本主体 |
| Proxy dispatch 回归 | 4,176/4,176 | 含既有四项 wire 补充文件与 URL guard 文件，和 core 有重叠，不累加为独立总数 |
| Images SSE 成功结算/交付专项 | 41/41 | completed 未 DONE、DONE 后取消、持久化失败/暂停/ACK 丢失、交付门控 |
| dispatch / staging 类型检查 | 两项通过 | 本地既有配置，未升级 compatibility flags |

已重新构建 core Node bundle 并冻结 204 条源码构建输入。生成前后核对摘要；此前 v249 的 2,967 条记录经必要的旧源码路径映射全部核验。机器记录保留本轮日志、源码、构建输入、固定测试包与历史材料，见 [v250 manifest](./C02-postgres-schema-v250-results.json)。

PGlite 为固定下载到独立目录的 0.5.8，实际引擎报告 PostgreSQL 18.3/WASM。ORM 使用合成表执行 DML；预算测试使用最小基础表和现有迁移 0040，真实执行事务与检查约束。提交 ACK 丢失由适配器合成，非网络故障。不是完整迁移、真实 Hyperdrive、postgres.js wire、多连接锁/取消或 Workers 运行时验收。[PGlite API](https://pglite.dev/docs/api)

## 首轮失败保留

`focused` 原始结果没有改写：SQL 合同 1 PASS / 46 FAIL；引擎当前实现 23 PASS / 47 FAIL。原因是两处测试断言错误：把整个 SQL 中限定名的出现总数当作物理 FROM/JOIN 次数，以及把 Drizzle 应用层映射键当作原始 SQL 返回列名。两份当时测试已归档；只修正断言，没有借此修改运行时代码或放宽 schema/金额要求。最终对照使用修正后的同一测试文件，修改前仍全部失败，当前全部通过。

## 剩余与运行边界

AST 字符串片段清单记录 863 处未限定候选，其中 PostgreSQL 专用模块 229 处、混合驱动模块 634 处。它是定位工具，不是缺陷数量或全覆盖证明；共享生成器、动态表名和触发器/函数需要继续追踪。下一项优先 `critical-writes` 混合片段、guardrail/workspace 预算，再推进其他仓储，不能只凭 ORM 测试宣称 Hyperdrive 已修好。

本轮 staging 管理/HTTP 调用、部署、生产写入、真实模型/KMS 调用均为 0；公共注册表的测试包和类型下载不属于云端验收。Workers 类型参考为 5.20260916.1，项目依赖版本未改。最近远端状态仍是历史 v232 观察，未重验；US$2 首轮累计上限不重置、最终增量账单未核验。新源码必须重新冻结后才可进行隔离 staging 验收。
