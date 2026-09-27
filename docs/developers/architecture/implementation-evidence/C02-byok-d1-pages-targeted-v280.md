# C02 v280：Pages 新增版本定点核验与准入缺口

2026-09-21，Checklist v1.178。**TARGETED_BINDINGS_OBSERVED_EXTERNAL_CONTRACT_PENDING**。补读 v279 新增的 5 个版本绑定，直接核验 cinaseek 的旧 active 部署及其两个可列 production 版本。32/32 管理 GET 成功；本轮没有业务源码变更、云写入或部署。原生 BYOK 准入仍未通过。

## 本轮取得的新证据

观察窗口 **2026-09-21 05:44:29.232–05:45:13.343 UTC**，44,111 ms。六个选定项目均先读取项目与 production 版本目录，按下述有限范围读取详情，再复核版本目录和项目配置。六个局部目录前后稳定，未见此前版本 ID 移除；这是分项目观察，不是全账户原子快照。

| 项目 | 当次 production 可列版本 | 本轮读详情 | 新增部署候选 |
| --- | ---: | ---: | --- |
| cinaseek | 2 | 2 | 无；旧 active 部署没有匹配候选 |
| cinashop-admin | 54 | 1 | 4813729e → 11626427-8ddc-44f9-a7e4-d8e74ccf7599 |
| cinashop-h5 | 63 | 1 | 136b9e2a → 8c19fc4d-50a8-42d7-bbea-53a546671d41 |
| cinashop-kefu | 21 | 1 | d2381a85 → b8915f3a-3d50-47b8-90a9-65c5c13397d4 |
| cinashop-pc | 42 | 1 | b4d86172 → 366423ba-63ce-4c5a-9ff1-60332fd99268 |
| cinashop-supplier | 21 | 1 | 4b7e0c7b → d723c2ed-1867-4b54-9063-1a4a7cdb5004 |

五个新增详情各只有 4 个 plain_text 绑定；cinaseek 两个详情各只有 6 个 plain_text。此次读取的七个详情均未出现指向四台 staging Worker 或 staging D1 的显式绑定。新版本与新增部署的关联仍来自 `CF_PAGES_URL` 候选，不是权威身份保证。

本轮没有重读这些项目的全部旧版本详情、其余项目或 preview 目录，不能将 v278 的旧快照加五个版本算作“当前全账户 370 个版本已经完整覆盖”。这次定点补充缩小的是五条新增部署的绑定调查缺口，不放行 `currentAllPagesVersionBindingsComplete`。

### 旧 active 记录：详情接口也未提供终态

对 cinaseek production 部署 `4c3f58d9-11b9-4875-adba-ad8165ff3180` 直接 GET，API 返回 `short_id=4c3f58d9`、Functions 显式 null、deploy / active、结束时间 null；其生命周期投影与 v279 列表完全一致。

详情的原始对象摘要与先前列表对象摘要不同；不同接口的对象不能仅因摘要不同就推断发生了状态变化。本轮仅证明所核对生命周期字段一致，没有解释剩余对象差异。

production 内部名仍为 `pages-worker--14050307-production`，两次版本目录都只列出两个版本；读取两者的 `CF_PAGES_URL` 候选分别为 `83a34847`、`ab9bcd3d`，没有 active 部署候选。annotations 均为空；script 元数据只有 etag / handlers / last_deployed_from 字段类型，没有取得可替代候选值的 deployment 身份。

因此仍无法区分“旧记录陈旧、从未形成执行资源、资源迁移或未被当前接口列出”等解释。没有取消、删除、重试或公开调用它。

## 官方契约调查的结果与限制

依照 Cloudflare 技能核对已安装 SDK / Wrangler，并用 Firecrawl 的 developer、官方站点搜索和指定页面读取查询公开契约。所有检索词均为通用技术词，未发送私有项目标识、代码或凭据。

[官方 Versions & deployments](https://developers.cloudflare.com/workers/versions-and-deployments/)明确一个版本捕获代码、绑定等状态，部署决定哪些版本承接流量；但这篇文档没有给出 Pages deployment ID 到内部版本 ID 的关联保证。已安装 Pages SDK 的 `short_id` 是部署的八字符 ID；`CF_PAGES_URL` 仍是版本的普通 plain_text 绑定，当前没有找到可据以宣告其不可覆盖或权威映射的官方说明。

检索还核对了 [Wrangler Pages 命令](https://developers.cloudflare.com/workers/wrangler/commands/pages/)与 [Pages 已知问题](https://developers.cloudflare.com/pages/platform/known-issues/)。这些页面没有解决本次 active、404 与内部版本完整性的具体问题。结论是“本次查阅未找到”，不是声称不存在任何其他官方接口。通用 Workers 的版本覆盖或版本亲和性文档也不被外推为 Pages 的保证。

已整理 [供应方核查草稿](./C02-pages-provider-questions-v280.md)，包含具体记录和五个明确问题，**尚未外发**。不自动创建支持工单或公开 issue，不上传完整本地证据，不请求任何资源修改。

## 对 staging 准入的实际影响

`byok-d1-operator.mjs` 要求可信预检提供七项证明；目录成功、ACK 或本地测试不能生成这些证明。目前相关状态如下：

| 准入证明 | 已有材料与仍需完成的动作 |
| --- | --- |
| sourcesFrozen | 实际执行前冻结候选、源码及完整初始基线；本轮不是候选冻结或部署许可 |
| priorCodeComplete | v271 已取得三台旧代码的完整归档能力与历史证据；执行前需重新确认当前版本一致 |
| exclusiveOwnership | 用户已授权独占 staging；仍需当次所有权及外部 D1 写入来源的实际证明，授权不等于自动停写 |
| allInvocationPathsInventoried | Pages 权威身份 / 404 / 可见性仍未知；11 个 Zone 路由仍缺可读证据，Dispatch 产品访问语义未解决 |
| actualPaidPlanVerified | v271 曾观察已有 Workers Paid；实际执行前刷新，不能长期继承历史套餐 |
| cumulativeBudgetReserved | 首轮 US$2 不能重置；历史预留不是余额，本轮未刷新实际账单 |
| maintenanceTimingQualified | v273 的时序接线和本地测试不能代替真实完整维护链；保持既有 5/10/15 秒规则 |

这不是要求枚举所有互联网客户端，也不把关闭 HTTP 当作 SQL 已静默；数据库原生围栏、维护许可与独立回读继续必需。当前只读清点器均不会输出完整准入通过值。未伪造预检布尔值来触发已获授权但尚未就绪的原生测试。

## 有限顺序与停止重复调查的边界

1. **外部事实**：核对当前 Token 的 11 个拒绝 Zone 资源范围 / 账号成员权限；请 Cloudflare 解释 Pages 身份、旧 active 和内部名 404 的保证。现有资料不足时不能靠重复同一查询变成证明。本轮未重复查询路由或四个预览候选的 404。
2. **收集器接线**：取得覆盖契约后，将有来源约束的当前清点、旧代码、套餐、预算 / 数据库基线、源码冻结及所有权接入真实只读预检提供器。不能用历史 manifest 或合成布尔值顶替。
3. **原生验证**：完整当次预检、入口关闭及维护时序条件满足后，才在现有 staging 内执行用户授权的 BYOK 用例；未知结果保留，不重放、不自动恢复旧实验。

不跨到 C03 或后续共享供给的真实集成，不改变已批准的 Images SSE 不可逆成功结算点。C02.G / C01 继续开放。

## 验证与计量

定点脚本最多 48 GET / 120 秒、顺序读取、单请求 20 秒、正文 2 MiB；实际 32 次全部 200，无自动重试。只保留非敏感标识、字段类型、绑定类型 / staging 关系和摘要，不保存环境变量值或构建日志。

66 条刷盘日志哈希链逐条核验。两份操作脚本语法检查通过；验证前次 94 项文件摘要、八个维护守卫、跨轮差异输入以及本轮 11 项材料。**没有重跑业务测试，不将 v279 的 369 PASS 冒充本轮结果。** 无运行时代码修改；本轮另外修正 Checklist 的 C02 表格列错位及指向旧 v228 的执行位置说明，依赖仍为 C01，未放宽发布门禁。

云写入、部署、D1 SQL、公开 Worker、模型与 KMS 调用均为 0；本轮 Firecrawl 仅访问公开资料。累计 US$2 不重置，账单未刷新。实际 BYOK 执行保留目录不存在。

[机器证据](./C02-byok-d1-pages-targeted-v280-results.json) · [供应方核查草稿](./C02-pages-provider-questions-v280.md) · [Zone 权限明细](./C02-byok-d1-route-permission-v274.md)
