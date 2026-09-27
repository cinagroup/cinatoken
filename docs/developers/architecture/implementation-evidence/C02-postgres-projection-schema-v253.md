# C02 — 组织身份投影与工作区 SQL 隔离

2026-09-16；Checklist v1.152。LOCAL_PASS，未部署；C02.G / C01 / 后续依赖仍开放。

## 实现范围

本轮处理两个身份投影仓储：

| 仓储/模板 | 既有表位置新增 schema 限定 |
| --- | ---: |
| `storage/organization-identity.ts` 的 PostgreSQL 事件、读取和关联路径 | 9 |
| `storage/workspaces.ts` 的 PostgreSQL 默认资源创建事务 | 17 |
| 工作区权限共享查询模板的 PostgreSQL 输出 | 7 |

共 33 处。共享模板改为内部闭合驱动选择：PostgreSQL 使用固定 `cinatoken_gateway.`，D1/MySQL 使用空前缀；不接受请求或租户指定 schema，不正则改写完成后的 SQL。现有占位符替换和 `$3::text` 保留。合同将 D1/MySQL 默认资源创建加访问查询的全部七条 SQL 与绑定参数分别与修改前 bundle 比较，逐字一致。

事件收件记录、组织及成员 upsert、旧事件排序、墓碑优先、登录后关联、默认工作区/Guardrail/版本创建、访问查询均使用业务 schema。仅依赖连接 search_path 不能保证这些读写指向正确表，尤其不能把直连会话假设当作 Hyperdrive 事务池合同。[PostgreSQL schemas](https://www.postgresql.org/docs/current/ddl-schemas.html)、[Hyperdrive 事务池](https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/#pooling-mode)

## 引擎发现并修复的鉴权副作用

只完成 schema 限定后，真实 SQL 引擎暴露 PostgreSQL 账户默认 Guardrail 创建语句缺少 `users` 的有效身份关联；其他创建语句以及 D1/MySQL 对应路径已有该检查。

因此，低层仓储收到错误 user/subject 配对、禁用用户或缺失外部身份时，最终权限列表虽为空，仍可能先创建账户默认 Guardrail/版本；不存在的 user 则触发 owner 外键失败。这是经仓储引擎验证的副作用，不据此推断未经验证的远程攻击路径。

已为该条 PostgreSQL SELECT 增加一个显式 schema 的 users JOIN，要求同一用户 ID、`external_system='cinaauth'`、相同 subject 和 active 状态。没有新增事务或扩大事务范围，保持原六条语句原子执行；不改变事件顺序、哈希、费用和重试策略。

## 引擎方法与最终对照

本地 PGlite 0.5.8 / PostgreSQL 18.3 WASM，顺序执行 68 个迁移 SQL 文件。复用 v251/v252 引擎适配器，增加 inbox 与 Guardrail 版本对照；共 24 张 public 同名表和 24 张临时同名表，带默认值、主键/唯一索引，部分行刻意使用其他 owner/角色/名称。

三个搜索路径分别为 `public, pg_temp`、`pg_catalog`、`pg_temp, public`。每项结束核对所有同名表的内容摘要未改变，调用方 search_path 也保持原样。引擎测试源码在首次失败后未修改：

| 同一最终测试源码下的产品版本 | PASS | FAIL |
| --- | ---: | ---: |
| 修改前两个模块 | 6 | 64 |
| 只限定 schema，仍缺账户默认资源身份 JOIN | 54 | 16 |
| 最终实现 | 70 | 0 |

70 项包含 69 个子测试和 1 个父测试。schema-only 的 16 个失败为五类无效 principal × 三种路径，加父测试；其中不存在的用户是外键错误，其余为不应发生的 gateway 写入。最终三个对照均无取消/跳过，不是线上故障统计。首轮 schema-only 54/16 及原源码、bundle、日志保留，没有降低测试断言。

覆盖事件的不可变收件回执、幂等/冲突、乱序、组织删除/成员移除同时间优先、后续较新事件、外部 source 保留、成员先到/延迟登录关联、真实末尾约束失败全事务回滚、processor token 唯一性、读取状态过滤；工作区默认资源幂等、组织默认/显式成员权限、角色投影、浏览器偏好回退、归档/暂停、默认版本失败回滚，以及无效 principal 不写入/不读取。

新增静态/方言合同 **5/5**。既有三个引擎和两组合同 **271/271**，core 主命令 **454/454**，SQL 相关脚本主体 **136/136**。详细数据见 [机器结果](./C02-postgres-projection-schema-v253-results.json)。引擎加入 opt-in `test:postgres-schema-engine`；新合同接入 `posttest:unit`，可单独运行 `test:postgres-projection-schema`。没有新增产品依赖或数据库迁移。

最终 dispatch 回归 **4,176/4,176**、Images SSE 结算/交付 **41/41**；dispatch 与 staging 两项类型检查通过。测试集有重叠，不相加作为独立覆盖；未执行完整 npm hook 链、全仓库或远程 CI，新增合同单独验证。

重新构建 core bundle 并冻结迁移/源码/日志，运行前后核验输入摘要。先前 4,229 条记录按匹配摘要映射至修改前归档后核对，旧 manifest 不改写；旧部署候选不代表本地源码，部署需要重新冻结。

## 未证明的内容与下一顺序

本地 SQL 引擎与窄参数适配器不证明 postgres.js 网络协议、TLS、Hyperdrive 后端切换、并发事件/锁竞争、真实角色与已有数据升级、迁移 CLI、Workers 原生容量或 Node 22。没有验证完整鉴权和全部管理仓储。session 兼容设置暂不删除。

剩余 lexical 候选为 PostgreSQL 专用 185 / 混合驱动 577（此前 185 / 610）；混合数字含合法 D1/MySQL，且不能穷尽动态 SQL。下一项继续 `management-workspaces` 和 `management-workspace-members` 的管理生命周期、审计事务及其他共享 SQL，然后推进剩余数据面与真实 PostgreSQL/Hyperdrive 门禁。

Workers/PostgreSQL 最佳实践技能促使本轮保留跨方言行为、区分真实 SQL 与目标运行时证明，并对“拒绝读取但仍发生写入”做事务实证。未修改 Workers 配置、生产资源或 Images 不可逆成功点。

Images 仍须有效 completed 图片 + 真实上游 DONE；先持久化结算事实再交付成功 DONE，之后取消不撤销费用，未知结果不重放推理。本轮云 API/部署/模型/KMS 调用全部 0；累计 US$2 不重置，历史 v232 远端观察及账单未重新核验。
