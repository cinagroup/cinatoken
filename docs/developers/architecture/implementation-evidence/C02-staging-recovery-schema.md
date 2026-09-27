# C02.B2.2 — staging 恢复 schema 与实验容量准备

2026-09-07；Checklist v1.57。**真实 staging D1 schema 已验证，恢复 Worker 未发布，C02.G 未通过。** 详细操作计数、对象摘要、失败记录与完整测量见 [结果 JSON](./C02-staging-recovery-schema-results.json)。接续 [v1.56 定义保护](./C02-image-recovery-schema-local.md)。

## 1. 云端实际变化

仅操作账户 `7ea8e46d8210bad342fa7595f7935fea` 下的 `cinatoken-staging` D1（`6bf5d41e-fe0b-4afa-9f67-ff5cf82e23d1`）：

- 发布前核对名称/UUID、1,114,112 字节数据库大小、68 份有序迁移记录、267 个原有 schema 对象的精确摘要和既有表计数；业务数据为空，仅保留初始化行。演示管理员 Key 无启用状态，外键检查通过。
- Gateway 与私有上游保持关闭；已有 Access 仅 deny-all。前后核对两个 staging Worker 版本，以及 Proxy/Admin/Chain 三个生产 Worker 的设置指纹，均未变化。生产只读设置，不读用户数据、不写资源。
- 三份已锁定 proposal 原文按顺序合并，**一次** D1 API 请求执行 20 条语句，返回成功；没有自动重试写入。新增四张恢复表及相关索引/触发器，正式迁移目录和 `d1_migrations` 仍为 68。
- 用实际运行时 checker 的相同只读 SQL，经 D1 REST 接口核对 **24 个对象、10,072 字节定义**，全部匹配；267 个原有对象摘要和原有表计数不变，外键零违规，四张恢复表均为 0 行。

D1 查询 API 支持以分号连接多条语句作为 batch；本次结果记录每次请求及实际语句数。[D1 Query API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)

这证明**真实 D1 的定义表示兼容和空输入回填**，不是 Worker binding/RPC 已运行，也不是非空旧数据回填、全库内容散列或线上漏日志问题已解决。草案仍不进入生产自动迁移；不得盲目重放含 ALTER 的 SQL。后续先检查当前对象与摘要，部分状态或差异必须停下核查，不能自动 DROP、IF NOT EXISTS 掩盖差异或重新推理补账。

## 2. 实验配置与测量

新增 [实验配置准备器](../../../../scripts/deploy/prepare-staging-recovery-experiment.mjs)，只在显式实验参数下生成独立、入口关闭的候选文件，不部署、不查询云端、不改源模板：

```powershell
node scripts/deploy/prepare-staging-recovery-experiment.mjs --prepare-unmeasured-staging-experiment
```

当前候选为单消费者、每批最多 5 项、30 秒租约、5 秒新准入窗口、**64 MiB 逻辑预留/池**。源模板仍 disabled/0，控制 Worker 未启用。生成目录为 `.wrangler/staging/recovery-experiment-v2`，首次创建限定防止覆盖已审阅文件；旧 32 MiB 文件仅保留为已否决候选证据，不部署它。生成文件中的 enabled=true 不代表云端已启用。

[Node 测量脚本](../../../../packages/proxy/scripts/staging/measure-recovery-workset.mjs) 使用真实 host、仓储和内存 SQLite；每个新进程消费五份接近 256 KiB 上限的不可变快照，覆盖 ASCII、Unicode 和密集审计 JSON，各重复三次。只在基线前 GC，在运行过程中于 SQL 边界观察内存，不注入强制 GC。

| 候选 / 场景 | 进程数 | 完成结算 | 结论 |
| --- | ---: | ---: | --- |
| 初始 32 MiB，零价 | 9 | 45 | 逻辑完成，但密集审计堆增量 33,656,208 字节已超过预留，另有约 5 MiB external；否决此预留假设 |
| 64 MiB，零价 | 9 | 45 | 完成；保留为下一步实验候选 |
| 64 MiB，合成每项 0.1 收费 | 9 | 45 | 完成；每进程合成预算支出 500,000 micros，容量计数归零；没有真实付费调用 |

最后一组密集审计最大堆增量 33,708,032 字节、external 增量 5,238,151 字节。**这不是 Workers 内存上界**：Node 24/Windows/tsx/SQLite 初始化后的进程基线 RSS 约数百 MiB，不可直接搬到 128 MB isolate；采样会漏过同步/原生峰值，也未计入真实 RPC/D1 传输。RSS 与 heap 不能相加，arrayBuffers 已包含在 external 中，不重复计算。各列最大值未必同一时刻出现；64 MiB 仅是据观察修订的试验分配，仍未验证完整运行时基线/安全余量、BYOK/guardrail/SSE/错误和跨消费者组合。

依据 Workers 技能进行配置隔离、绑定类型生成和离线打包；保留候选与生产验收的区别。[Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)

## 3. 验证与保留的失败

新增配置测试 **17/17**；完整 staging 本地链 **35 + 7 + 130 + 39 + 65 + 60 + 24 = 360** 项通过，最后进程退出测试已等待至退出码 0。27 组测量不是另外 27 项独立功能测试，不与 suite 计数混加。staging/dispatch-safety 定向类型检查及候选绑定 types --check 通过；完整 Core 类型检查依旧 **FAIL，32 条与 v1.51 基线相同**。本轮没有重跑独立 Core 135 项或完整 dispatch-safety 行为 suite，不把历史结果算成本轮。

Wrangler 4.127.1 离线包 342,046 字节 / gzip 64.99 KiB，导出 UsageRecovery/default，仅外部依赖 cloudflare:workers；这不是云端发布或内存证明。

保留三类非成功过程：

1. 首次只读预检第 4 次管理请求收到非 JSON 响应，未执行 SQL；第二次在版本探针收到 400/7500。单独诊断确认 D1 禁止 sqlite_version()，不把它误判为缺少凭据权限；移除非必需版本探针后继续检查实际对象，不降低 schema 检查。
2. 初始配置测试因测试帮助函数把 URL 传给要求字符串路径的 JSONC 解析器而 11 项失败，另 6 项泛化拒绝断言并非有效证明。改用 fileURLToPath，并要求准确的断言错误；最终 17 项通过，未放宽配置门禁。
3. 32 MiB 数值池能够通过逻辑计数测试，但观测工作集反驳了预留假设；没有把“成功结算”当作容量足够。

## 4. 费用与下一步

本轮共 **47 次管理请求**（30 GET、17 SQL POST 尝试，其中 2 次版本探针失败无行数元数据）；成功 SQL 元数据共读取 **3,841 行、写入 30 行**。唯一写请求是 schema batch；未发布 Worker、未新增公网 HTTP 测试、模型/KMS 均 0。首轮历史 HTTP 98，累计 **US$2 不重置**。

按当前 Paid 超额行计费、不假定共享免费额度，已返回元数据对应约 US$0.000033841；此数不包含存储、失败探针缺失元数据及历史费用，**不是最终累计账单**。本次实验保守预算 US$0.02，最终增量账单仍待核验。[D1 计费](https://developers.cloudflare.com/d1/platform/pricing/)

下一步：重新核验资源与专用 Access 应用/最小服务身份策略，封闭发布实验接收/控制 Worker，再进行真实 Workers 授权、无体 POST、RPC/D1、终止恢复和完整工作集观察。不得因 schema 或 Node 测量通过而开放生产、增加并发或启用生产容量池。原线上漏日志事件、C02.G 和 C03–C20 均未关闭。

