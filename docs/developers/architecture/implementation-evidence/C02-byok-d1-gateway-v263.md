# C02 v263：BYOK 专用用例入口

2026-09-20，Checklist v1.162。**LOCAL_PASS / STAGING_PARTIAL；未部署，未执行真实 Workers/D1 验收。** 用户允许独占现有 staging 的授权继续有效，本轮未进行云端切换。C02.G / C01 不放行。

## 本轮补齐

新增 `byok-d1-gateway-worker.ts` 专用候选，复用现有 `cinatoken-proxy-staging` 名称，只绑定现有 staging D1。配置默认 enable=false、Access audience 为空、workers.dev/preview 关闭，无路由或定时器。不加载产品应用、推理路由、上游 service binding、清理 RPC 或 KMS；不是新增 Worker 资源。

入口仅接受固定 staging origin 下十个既定用例与 STOP。必须同时满足显式 staging/enable、原生 Access audience、64 位十六进制 bearer、对应命令头和空 POST；URL 长度最多 2,048，拒绝查询串、片段、浏览器 Origin、Transfer-Encoding 和非零 Content-Length。身份请求头不能替代原生 Access。令牌摘要匹配和数据库时钟 CAS 继续由原一次性处理器负责，未修改该处理器或产品 SQL。

接入现有一字节 BYOB 空正文检查，只有真实 EOF 才转换成无正文 Request；保留原取消信号，不丢弃未验证的正文。这解决了原处理器要求 `request.body === null` 与原生空 POST 可能有字节流之间的接线问题。外层在读取正文前登记 waitUntil，原处理器在 D1 前再次登记；任一登记失败都不发出 D1 调用。

用例与 STOP 各有一个独立的本地负载槽，只共享布尔值，不共享请求/令牌/Promise。用例正文或 SQL 卡住时，STOP 仍可停止后续准入；不会将 pending 清零、自动清理、重开围栏或宣称 SQL 已取消。跨实例的一次性认领仍依赖 D1 CAS，不依赖本地负载槽。超时、已提交但确认丢失及未知结果继续保留，不自动重放。

## 已验证

- 新增源码检查 **41/41**，浏览器 ESM 工厂与实际 default Worker 入口打包版再跑 **41/41**；重复运行不计作额外独立覆盖。
- 覆盖未授权零 DB/正文读取、伪造身份头、固定路径、非空/已读/锁定/非字节流正文、取消/超时、等待真实 cancel 完成才释放负载槽、内外层生命周期登记失败、STOP 独立通道、跨上下文竞争、断连后继续留存回执和确认丢失不重放。
- 在完整本地迁移 SQLite 上，十用例从新 gateway 进入旧一次性处理器，逐一核对持久回执，再 STOP、封闭围栏、调用独立清理接收端。清除 664 条专属合成记录，事务 143 条语句；保留 finished maintenance 许可和 closed 围栏，其他全表数据逐行恢复到捕获基线。许可和关闭凭据在测试中合成，不是实际 Access、关闭观察或原生 D1 证明。
- 回归 **517/517**：独立清理控制链 72、围栏 36、清理 40、一次性处理器 29、验收程序 19、原空正文/恢复控制 76、BYOK 204、Images SSE 成功规则 41。
- staging TypeScript、Wrangler 生成绑定 `types --check`、类型模块隔离、单份 `deploy --dry-run` 通过。离线候选 353.05 KiB / gzip 64.64 KiB；没有真实上传。
- 运行时为 Windows Node 24.14.1 / node:sqlite，Wrangler 4.127.1；未把它们记作 Workers、原生 Access、原生 D1 或 Node 22 验收。现有全部 8,405 条文件摘要和一个链接目标摘要在实现前后核验，旧源码及旧 manifest 未改。

初始 40 项检查通过后增加实际 default 入口成功执行检查；最终为 41 项。首次 Wrangler 版本查询出现用户默认日志目录 EPERM，后续改用工作区日志路径，没有更改系统权限。最新 workers-types 从官方 npm registry 下载仍被 EACCES 阻止，沿用已下载 **5.20260916.1** 并以 Wrangler 生成绑定校验，不声称已下载最新版。诊断笔记和最终各项原始输出保留。

本轮使用 Workers 最佳实践与 Wrangler 技能落实绑定类型生成、默认关闭配置和生命周期登记；参考当天[官方 Access 文档](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)核对 `ctx.access`，不信任伪造身份头。[waitUntil 文档](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil)说明 HTTP 断连后的有限持有期，不能据此推出数据库停写。Firecrawl CLI 不可用，文档检索回退官方网页。

机器证据：[v263 摘要清单](./C02-byok-d1-gateway-v263-results.json)。可重跑：`node .wrangler/staging/verify-byok-gateway-v263.mjs local-<新标签>`；目录排他创建，不覆盖历史输出。

## 剩余有限顺序

1. 补齐主机端用例 HTTP 单次发送/严格回执校验，并接到现有排他日志。异常后的 STOP/封闭/撤销也必须具有明确的一次性日志与失败收尾；不能仅靠 gateway 的数据库 CAS 代替主机消费记录。
2. 将围栏安装与封闭、基线捕获、控制/maintenance 首次 INSERT、Access/入口启闭、清理与独立最终复核接成固定资源的完整操作器。当前专用 Worker 与已有清理调用器只是组件，不能直接作为完整执行命令。
3. 定义独占结束后的受控恢复基线。默认保留 closed 围栏与清理回执、关闭所有实验入口；不自动删除保护或恢复其他实验。冻结全部候选后，重新核验现有套餐、完整 SQL 调用预算、当前隔离状态和累计费用，再执行一次原生验收；不自动升级套餐或新建资源。

本轮 Cloudflare 管理/Worker HTTP、D1 云读写、部署、生产写入、模型/KMS 调用均 **0**。最后实际云观察仍为 v257 的 **2026-09-16T04:43:08.731Z**，公开 HTTP 累计 422；今天没有重验云端。首轮累计 **US$2 上限不重置**，US$1.20 历史/延迟预留与 US$0.80 未分配预留不变，不是实际剩余余额，最终增量账单未确认。真实工作区执行占位未创建。

Images 成功点保持“有效 completed 图片 + 真实上游 DONE”，持久化成功事实后才交付成功 DONE；后续取消不撤销费用。未修改生产算法、现有部署或迁移。原生事务/并发/中途到期、完整 Workers 容量及其他后续门禁继续开放。
