# C02 v254：管理工作区与成员 SQL schema 隔离

日期：2026-09-16。Checklist v1.153。LOCAL_PASS / 整体 STAGING_PARTIAL；未部署，C02.G / C01 不放行。

## 修改范围

`packages/core/src/storage/management-workspaces.ts` 的 PostgreSQL 分支和私有 PostgreSQL 鉴权谓词共 28 处表位置，以及 `management-workspace-members.ts` PostgreSQL 分支 23 处表位置，均显式使用 `cinatoken_gateway`。

没有改变账户谓词、角色映射、撤销/过期判断、绑定参数、分页、锁定对象、事务范围、审计语义、默认工作区墓碑或费用算法。归一化换行后，去掉新增固定 schema 前缀与修改前源码完全一致；另用 AST 检查前缀仅存在于 PostgreSQL 分支，防止误改 D1/MySQL。不添加运行时 SQL 改写器、生产依赖或新迁移。

这样可避免这两处仓储受会话 `search_path` 或 public/临时同名表影响；不能据此推断整个数据面已适配 Hyperdrive。Hyperdrive 的事务池会重置后端连接设置，仍需真实池化环境验收。[Cloudflare 池化语义](https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/#pooling-mode)、[PostgreSQL schema 解析](https://www.postgresql.org/docs/current/ddl-schemas.html)

## 本地引擎验证

使用已有独立 PGlite 0.5.8 / PostgreSQL 18.3 WASM；仅测试时加载本地模块，未加入产品依赖。复用 v251–v253 的窄 SQL 适配器，应用全部 68 个迁移 SQL。24 张带主键/唯一索引的同名表分别存在于 public 和 pg_temp，每项检查前后比对其全部行摘要。

三个 search_path：`cinatoken_gateway,public`、`public,pg_temp`、`pg_temp,public`。注意第一个配置没有显式把 pg_temp 放后，临时表仍能隐式优先，用于揭露未限定表名。

新增引擎 100/100（33 个场景 × 3 条搜索路径 + 1 父测试），静态合同 2/2，覆盖：

- 个人/组织账户列表、分页、创建者身份、ID 优先于 slug、跨账户/归档拒绝。
- 创建工作区及默认 Guardrail/version/audit；唯一冲突回滚；设置合并与显式清空。
- 活跃推理密钥删除保护、默认工作区确认与墓碑、账户默认 Guardrail 的同账户锚点迁移。
- 个人 owner、默认组织成员派生、自定义工作区成员与活跃组织成员交集、组织角色映射。
- 成员新增、重新激活保留 ID/创建时间、批量未知成员零写入、删除幂等和活跃密钥保护。
- 撤销/过期管理密钥、禁用个人 owner、暂停组织的零副作用拒绝。
- 五类变更在末尾审计约束失败时真实事务回滚；gateway 缺表失败关闭而非回落同名表。

新增 `test:postgres-management-schema` 并接入 `posttest:unit`；第五组引擎加入 `test:postgres-schema-engine`。`GATEWAY_PG_MANAGEMENT_BASELINE_DIR` 仅在测试中选择归档旧模块；产品不读取它。

## 中间失败记录

首次运行引擎 54 PASS / 46 FAIL、静态合同 0 PASS / 2 FAIL。单行补丁上下文重复，导致部分限定落到错误方言分支；已用完整文件上下文纠正，并增加非 PostgreSQL 分支不得出现前缀的合同。测试还存在 slug 交换顺序和账户默认规则字段缺失两处夹具错误，均按实际约束修正。

第二轮引擎 96 PASS / 4 FAIL，静态合同 2/2。剩余场景把已有显式 assignment 的普通 Guardrail 直接改为账户默认规则，迁移锚点时触发复合外键。应用仓储与管理路由禁止向默认规则添加显式 assignment（`management-guardrail-assignments.ts` 和 `management-guardrails.test.ts` 有现存判断/测试），因此改为独立创建隐式继承的默认规则；未放松断言或改动产品规则。此轮旧模块对照 12 PASS / 88 FAIL，但最终结论以最后同测试源码重跑为准。

两轮失败日志、原产品源码、测试源码及构建均保留在 `.wrangler/staging/pg-management-v254/`；不是只保留最终绿灯。

## 证据边界与下一步

最终同一份测试源码运行旧模块为 12 PASS / 88 FAIL、修复模块为 100 PASS / 0 FAIL；均无取消或跳过。既有引擎/合同 346/346、core 主集 454/454、SQL 相关脚本体 136/136、dispatch 4,176/4,176、Images SSE 41/41，以及 dispatch/staging 两项类型检查通过。未执行完整 npm hook 链或远程 CI；这些套件有重叠，不汇总成独立用例数。

历史 v253 的 4,662 条摘要按修改前归档核验；不重写旧 manifest。新 core Node bundle、构建输入、迁移、测试、初始失败及最终结果均纳入 [机器证据](./C02-postgres-management-schema-v254-results.json)。旧 CLI 应拒绝当前源码漂移，后续发布必须重新构建冻结，不得复用旧云候选。

本地引擎不是 postgres.js 网络协议、TLS、真实迁移 CLI、生产角色/旧数据升级、多连接并发、Hyperdrive、Workers 原生容量、Node 22 或远程 CI 证明。测试通过不代表并发撤销和删除竞态已验收。

最新词法扫描剩余 711 处候选：PostgreSQL 专用文件 185、混合驱动文件 526。混合驱动含合法 D1/MySQL，不是 526 个 PostgreSQL 缺陷；扫描不覆盖所有动态 SQL。下一步继续 `users.impl.ts` 等剩余身份/共享 SQL，再处理路由/模型/供应商及剩余管理仓储；数据库原生时限、已使用客户端关闭和全工作集容量继续开放。

本轮 Cloudflare 管理调用、部署、模型和 KMS 调用均为 0，生产未操作。首轮累计 US$2 不重置，旧云端 v232 关闭观察没有重验，不能称为当前已核验状态。云端候选不是本地新源码；后续验收须重新冻结构建并复核隔离和预算。

Images 不可逆成功点保持“有效 completed 图片 + 真实上游 `[DONE]`”；先持久化结算事实再交付成功 DONE，之后客户端取消不撤销费用。本轮不改 Images 实现。
