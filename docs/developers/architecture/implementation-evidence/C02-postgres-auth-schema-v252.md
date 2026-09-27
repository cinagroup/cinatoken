# C02 — PostgreSQL 密钥鉴权与管理 SQL 表定位

2026-09-16；Checklist v1.151。LOCAL_PASS；未部署，C02.G / C01 / 后续依赖不放行。

## 本轮实现

显式限定 `cinatoken_gateway` 的 37 处原始 SQL 表位置：

- `db/postgres/api-keys.impl.ts`：22 处，覆盖当前密钥/管理列表/用量窗口、账户范围更新与删除，以及普通硬删除的预留/历史日志保护条件。
- `storage/management-api-keys.ts` 的 PostgreSQL 分支：15 处，覆盖管理密钥与账户 owner 关联、last-used 更新、列表/读取、创建/撤销与审计事务、工作区所属账户查询。

校验器将当前文件移除新增 schema 前缀后与冻结前源码精确比较；混合驱动文件还分别比较 PostgreSQL 分支前后文本，D1/MySQL 完全不变。未修改鉴权条件、哈希/迁移策略、金额算法、事务范围、业务重试或历史迁移。本轮没有新增数据库迁移。

业务表的定位不能依赖池化连接上一次性设置的搜索路径；存在同名表时，未限定 SQL 也可能读取或写入错误对象。这里修复静态表定位，不声称已经模拟 Hyperdrive 的后端池化行为。[PostgreSQL schema 与搜索路径](https://www.postgresql.org/docs/current/ddl-schemas.html)、[Cloudflare Hyperdrive 事务池](https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/#pooling-mode)

## SQL 引擎验证

使用本地 PGlite 0.5.8 / PostgreSQL 18.3 WASM，实际顺序执行 68 个迁移 SQL 文件。复用 v251 财务引擎，另建组织、两类成员关系和管理密钥的同名表；共 22 张 public 表和 22 张临时表，具有默认值、主键/唯一索引及刻意不同的数据。窄适配器只将仓储 tagged template 的标量参数转成占位符，真实 SQL、返回值和事务回滚均由引擎执行，不在 mock 中实现鉴权判断。

三种搜索路径为 `public, pg_temp`、`pg_catalog`、`pg_temp, public`。每项结束检查所有同名表的内容摘要未变，同时检查调用者 search_path 未变。当前版本 **118/118**（117 子测试 + 1 父测试），另有静态合同 **2/2**。

覆盖内容：

- 推理哈希鉴权、仅哈希查找不回退明文、合法旧密钥惰性迁移；管理密钥与推理密钥不能混用。
- revoked/expired、禁用用户、归档工作区、个人 owner 不匹配、暂停组织、缺外部身份；组织成员和非默认工作区成员的当前状态。
- 当前密钥普通/BYOK 四个费用窗口、已消费金额排除预留金额；个人/组织管理范围、禁用过滤、分页、参数化名称、限额 epoch。
- 管理密钥认证和 last-used、两个 owner 形态的列表与查找、工作区所属范围；个人及组织创建/撤销的审计事务和真实审计约束失败后的回滚。
- 两种删除入口的 reserved/dispatched 普通与 Guardrail 预留保护、历史已收费请求保护、删除幂等；缺 gateway 表时必须失败，不回落到同名表。

引擎通过显式 opt-in 的 `test:postgres-schema-engine` 运行；静态合同接入 core `posttest:unit`，也可运行 `test:postgres-auth-schema`。未添加产品依赖。

## 中间结果与复现边界

首轮引擎 111 PASS / 7 FAIL：两个夹具问题分别在三种路径中触发，加一个父测试失败。其一修改了仍被预留外键引用的窗口主键，其二只清空外部身份配对字段之一。修正夹具，保留产品约束；静态合同的预期位置数由误写的 14 改为实测 15，首轮 1 PASS / 1 FAIL 记录保留。

第二轮当前实现 116 PASS / 0 FAIL / 2 CANCELLED；旧代码 40 PASS / 76 FAIL / 2 CANCELLED。两者受 60 秒父测试时限影响，不作为完整对照结论。最终仅将测试运行器时限调为 180 秒，产品 deadline 未变；原日志、测试源码和摘要均归档，不覆盖失败记录。

最终同源码对照：旧代码 **45 PASS / 73 FAIL / 0 CANCELLED**，修复后 **118 PASS / 0 FAIL / 0 CANCELLED**。旧代码来自修改前冻结的两个模块 bundle，其余锁定依赖和全套迁移保持一致。既有 ORM/预算引擎 70 项、财务引擎 77 项及财务合同 4 项合计 **151/151**；core 主命令 **454/454**，SQL 相关脚本主体 **136/136**。详细回归见 [机器结果](./C02-postgres-auth-schema-v252-results.json)。这些测试不是线上故障统计，也不代表旧版本所有路径必然失败。

最终 dispatch 回归 **4,176/4,176**、Images SSE 结算/交付 **41/41**；dispatch 与 staging 两项类型检查通过。测试集有重叠，不能相加当作独立覆盖；未执行完整仓库、完整 npm hook 链或远程 CI。两个新静态合同单独执行，已有 hook 保留并接入新合同。

重新构建 core Node bundle，冻结输入、68 个迁移、测试与原始日志，运行前后核对摘要。此前 3,796 条记录按匹配摘要映射到修改前归档并验证；不改写旧 manifest。当前源码不是旧 staging 候选，新部署必须重新冻结构建。

## 未通过门禁与下一顺序

这是两个密钥仓储的 schema 子集，不是鉴权安全全面审计。尚未验证并发撤销与认证竞争、真实 postgres.js wire/TLS、Hyperdrive 后端切换、多连接锁、真实角色/已有数据升级、迁移 CLI、Workers 原生容量或 Node 22。整个鉴权/共享仓储仍有其他原始 SQL，session 兼容设置暂时保留。

候选扫描从 PG 专用 207 / 混合 625 降至 **185 / 610**。混合候选含合法 D1/MySQL，不代表 610 个 PostgreSQL 缺陷；lexical 扫描也不能穷尽动态 builder。下一项继续组织/工作区身份投影及其他鉴权共享 SQL，再覆盖路由/管理仓储，随后执行真实 PostgreSQL/Hyperdrive 门禁。

Workers 与 PostgreSQL 最佳实践技能促使本轮明确区分会话设置、SQL 引擎和目标池化运行时的证明范围；本轮没有改 Workers 绑定或配置。

Images 成功点仍为“有效 completed 图片 + 真实上游 `[DONE]`”，先持久化结算事实再交付成功 DONE；随后客户端取消不撤销费用。没有上游 DONE 则不提前成功，结算确认不明不自动重放推理。

本轮云 API、部署、真实模型/KMS 调用全部 0；生产未改。首轮累计 US$2 上限不重置；远端状态仍仅继承 v232 的历史观察，未刷新账单或远端状态。下一次云验必须重新冻结候选并复核隔离与剩余预算。
