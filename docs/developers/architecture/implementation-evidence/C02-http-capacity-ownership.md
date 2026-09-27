# C02.B2.2 — HTTP 容量准入与独立持有者

日期：2026-09-06。状态：基础合同与 HTTP 可选接入 LOCAL_PASS；**生产未启用，整个实例内存门禁未通过**。完整 [容量合同与后续顺序](../request-capacity-contract.md)。前一 [Images 名称/审计限额](./C02-image-audit-limits.md) 已完成，本轮不更改这些公开限额或历史测量。

## 实现

- 新容量池同步约束逻辑预留字节数和在途请求数，不排队、不保存请求内容；整数验证、配置快照、减法防溢出、幂等归还及禁止旧 lease 复活。
- `createProxyApp` 可选 HTTP 准入位于所有正文/鉴权/存储处理之前，所有方法/路径收取固定预留，503 `gateway.capacity_unavailable` 脱敏拒绝。HTTP-only 配置明确拒绝 Upgrade / Node Realtime，不用协议头绕开容量。
- 入口处理、按需响应流、受管后台记账和取消清理独立持有同一预留；取消客户端交付不等待清理 ACK，但额度继续保持。HEAD 主动取消被框架丢弃的正文，无正文响应不制造空的正文持有者。
- 原后台调度在 Workers 保留 `waitUntil`，Node 保留受管集合；不更改计费、退款、上游重放、真实账本或 KMS 逻辑。Workers/Node 工厂均未配置 `httpCapacity`，默认路径无新增流包装。

## 验证与失败记录

新增 **59 项**：容量池 20、响应所有权 8、HTTP 应用/本机连接 25、后台持有 6；后台文件另外保留 2 项旧测试，因此四文件定点总数为 **61**。测试包含六种持有者结束顺序、精确上限、100 个并发申请、别名/头部绕过、未读正文、HEAD、204、handler error、后台 rejection、取消清理延迟/失败和取消监听移除。

本机 HTTP 测试绑定随机 `127.0.0.1` 端口，经过 `@hono/node-server`：先收到流数据，另一个请求被 503 拒绝；断开第一个客户端后，生产者清理和记账仍各自占用，最后全部结束才归还。没有连接真实模型或业务数据库，测试端口和连接均收尾。它验证 Node 24 的断连传递，**不是**整机内存/网络 ACK 或真实数据库事务验收。其他 HTTP 路径测试在实际应用入口用 `beforeAll` 合成后续工作，不能冒充各模态真实财务集成测试。

首轮定点 52 项通过、后台测试文件导入失败：Hono 的 Context 不是运行时公开导出；第二次候选子路径也不可导入。最终改为结构化最小测试上下文，不绕到依赖私有文件。首次 Proxy 类型检查发现泛型 Context 的完整 get 重载不兼容，改成仅需要容量 getter 与 waitUntil 的窄接口。首次安全类型检查发现测试 fixture 同步返回与 MiddlewareHandler 签名不符、Node server 联合类型未收窄；补异步适配与运行时类型断言。未删除测试、未加类型忽略。

最终四文件定点 61 项通过；完整 pretest 链与主 suite **3,048 tests / 135 suites，退出 0**；安全专项 **2,675 tests / 50 suites，退出 0**；Proxy、dispatch-safety、Admin 三项类型检查均退出 0，无失败/取消/跳过。安全专项原先不含后台文件的 2 项旧测试，本次一并纳入，所以增长 61；主 suite 增长 59。两套 suite 有重叠，不相加。Node 断连 fixture 会产生固定的预期中断日志，后台 rejection fixture 也有预期日志，不是未捕获测试失败。

收尾自检还显式清除正文适配器内捕获 Context 的生命周期回调，避免消费者长期保留已完成 Response 时保留这条应用引用；随后再次完成两套全量回归和三项类型检查。所有测试进程均已退出。执行命令为 `npm test -w @octafuse/proxy`、`npm run test:dispatch-safety -w @octafuse/proxy`、`npm run typecheck -w @octafuse/proxy`、`npm run typecheck:dispatch-safety -w @octafuse/proxy`、`npm run typecheck -w @octafuse/admin`。终端输出有工具截断，保存的是结果摘要，不声称留存了完整原始日志。

## 未完成与唯一下一项

**C02.B2.2 — 实际运行配置、跨消费者容量与 host 持有期验收**。本轮没有新增实际内存测量，没有生产预算默认值/环境开关，也没有自动缩减 50/20/32 MiB 合同。HTTP 以外的 Admin、Realtime host/session、Cron、Queue，以及后台生产者内部缓冲、数据库确认/恢复、运行时取消期限，都不能从逻辑 lease 推断已覆盖。永不终止任务继续占用可能影响可用性，不能用超时释放假装完成。

C00 LOCAL_PASS；C01/C02 DOING；C03–C20 TODO。C02.1–C02.7/C02.G 不勾选；其他入口时限、marker/Guardrail 零更新、共享音频收益、Qwen、Node 22/真实 Workers/数据库门禁保持。有限实施顺序见合同第 4 节。

## 基线、回退与外部动作

HEAD `7eb59008f7d8e156e81fd18a57658fdef2553264`。起点 264 个 dirty/untracked 文件；修改前已重核前一 214 文件快照，全部匹配。本轮 [源码/合同快照](./C02-http-capacity-ownership-snapshot.json) 单独保存，不覆盖历史。

最终快照 222 项哈希全部匹配；5 份当前/接续文档的 58 个本地链接目标存在（文件存在性，不是全部锚点渲染验收）。`git diff --check` 通过。最终 275 个 dirty/untracked 文件：本轮更新 8 份起点已有 dirty 文件、改动 2 份原先 clean 的受跟踪文件，并新增 9 份文件；起点文件无缺失。保留用户其余改动，没有将整个工作树当成本轮补丁。

回退仅移除本增量的可选 `httpCapacity`、容量服务/正文包装、后台 lease 登记、新错误码与配套测试/文档；保留原后台调度、其他脏工作树和已获批准的字段上限。若将来启用，不可在途强清零池；须停止新准入并按既定 host 排空/恢复合同处理。

无提交、部署、安装、云写入、真实 KMS/OAuth/模型、业务库、迁移、支付、远程 CI。Google Cloud KMS 项目 `cinatoken` 沿用既有证据，无重复云检查。

使用 Workers 最佳实践技能决定按需流转发、`waitUntil` 持有与避免全局保存请求内容；已检索 [官方最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/) 和 [后台生命周期](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil)。最新 types registry 不可读，回退核对已安装 5.20260829.1 的 ExecutionContext / Streams / Response 类型和本地 Wrangler schema；未改平台配置。
