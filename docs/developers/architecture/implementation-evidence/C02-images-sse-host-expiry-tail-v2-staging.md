# C02 — 原生 SSE 取消采集修复与独立恢复

2026-09-08；Checklist v1.101。状态：**STAGING_PARTIAL**。修复实时 tail 的 canceled/缺省响应兼容与首错保留，取得两个请求的原生取消事件；对已落库成功快照完成独立恢复及零提交去重。原整轮测试因本机墙上时钟回跳失败，故仍保留 FAIL_CLOCK_ORDER，不把后续补救改写为原实验通过。C02.G 未通过。

## 业务事实与恢复

本轮复用 v1.100 已部署的冻结 Worker，没有新发布、迁移或生产算法变更。两个新请求均收到有效 completed 图片，私有上游探针均确认实际 completed 与 DONE，客户端真实待决 HTTP 读取均以 AbortError 结束；D1 独立观察原始 Request.signal 取消并保留当时快照字节。

| 观察窗口 | 平台取消后的持久化事实 | 独立恢复结果 |
| --- | --- | --- |
| before-hold / INSERT 前 | 一份 intent、dispatched 预算预留；没有成功快照、恢复任务、回执或账单 | 仍为 intent-only/unknown，不补造用量、退款或成功回执 |
| after-hold / INSERT 已提交但 ACK 未返回 | 成功快照与 pending 恢复任务各一份；held-after-insert 保留原生 success、changes=2、rowsWritten=9、identityVerified=true | 独立控制端扫描/认领/提交各 1；生成唯一回执和账单；再次扫描/认领/提交均 0，全部六组财务行不变 |

两个原生 tail 均保留 outcome=canceled，responseStatus=null，没有将其伪造成 ok 或平台 200。另有操作器真实客户端 200 观察。两条平台警告均比各自 D1 原生取消晚 **30.004 秒**；尾日志共两条、9,126 字节。部署版本、规范路径、三个探针头、请求身份和取消时的 held 字节相互匹配。未改写 probe phase，也未重发这两次推理。

成功点继续遵循用户确认的“有效 completed 图片 + 实际上游 DONE”；之后取消不撤销成功费用。写入后的快照可以恢复且只结算一次；**写入前的成功事实仍可能缺少足够的耐久账单输入**，客户 unknown/幂等政策与该持久化缺口尚未完成，不能用合成夹具删除掩盖。

## 采集器修复

新增版本化校验器和可测试的有界采集模块，不覆盖 v1.98–v1.100 冻结文件：

- 接受并原样保留 ok/canceled；其他 outcome、异常、截断或缺失原生警告仍拒绝。仅 canceled 允许缺省 native response；完整证据校验还必须有独立客户端 200。
- 单条 128 KiB、整轮 512 KiB、最多 8 条消息和 2 个匹配事件；先检查字节预算再解析 JSON，拒绝重复身份和错误版本。
- 第一处失败不可被后续 error/close 覆盖。只保存封闭枚举的失败阶段、计数及消息摘要，不保存任意异常文本、原始认证头、URL 凭证或应用日志。
- 本轮原生事件证实了 canceled + 缺省 response 的实际组合，采集器没有首错，两条投影均保留。

遵循 Workers 最佳实践技能，复核当前官方文档和 `@cloudflare/workers-types` 5.20260908.1，其中 fetch trace 的 response 为可选；本轮没有改 Worker 配置或生成手写绑定类型。后台任务取消只证明请求级 waitUntil 生命周期，不外推整个 isolate 回收。[Cloudflare context 生命周期](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil)。

## 原实验失败与补救记录

after-hold 的本机 startedAt 为 `10:25:52.920Z`，headersAt 却为 `10:25:51.604Z`。操作程序先发起 fetch 再读取响应，墙上时钟数值出现回跳，导致本机时间排序断言失败。原始记录、两个已捕获的 tail 和 pending 快照均保留；未篡改时间戳让实验变绿。

新增明确用于事故对账的校验合同：在同一平台时钟上验证 invocation → 原始取消 → 原生警告，另验证精确身份、客户端状态和未变快照；本机时间仅校验格式，不据此宣称时序通过。其清理返回 experimentPassed=false，允许安全处理有完整原生和财务证据的合成对象，但不能替代未来单调时钟验收。

第一次独立恢复已经提交成功，随后操作脚本使用了不符合既有 canonical tokenName 规则的临时名称，完整 oracle/通用清理器拒绝继续。这是操作脚本错误，不是恢复失败，也没有重新执行这笔推理或结算。立即关闭固定控制入口；首次恢复 deny-all 因 service-auth redirect 尚开启被 400 拒绝。按既有正确顺序停用令牌、关闭 redirect、恢复 deny-all、删除令牌后，API 省略默认 false 字段又触发过严格等值断言；独立只读检查最终确认双入口关闭、策略关闭、令牌不存在。

最后用规范临时令牌，仅开放恢复控制端，不开放推理网关；执行一次零提交检查并完成原子数据清理。上述失败操作报告全部保留，累计调用不重置。下一步操作器应在开放入口前验证整个 canonical journal，并改用单调时钟记录事件顺序和等待期限，墙上时钟仅作审计显示。

## 测试、收尾与费用

完整专项回归 **1,250/1,250 PASS**，零失败、取消或跳过：保留原回归和 v1.100 的持久化日志测试，增加 canceled/缺省响应、首错保留、字节/数量预算、时钟偏差、完整原子清理，以及 18 项时钟事故对账正反例。首次完整组合 1,232 项亦通过。Node 22、远程 CI 尚未运行；本轮没有修改 Worker，也未重跑其类型检查。

最终清理只删除规范合成夹具。先保存完整账务、取消观察、原生 tail 和所有者证据，再执行含全字段/数量守卫的单个原子 batch；不调整真实客户余额，不伪造退款。清理后 56 张表计数与 295 项 schema 恢复预检基线；四个 staging Worker 及两个 Access 应用关闭，临时令牌和 tail 均回收，生产配置指纹未变。合成数据可依据保存的夹具重建，原始观察报告未删除。

本轮没有新部署、真实模型调用或 KMS 调用；首轮累计 **US$2 上限不重置**。预检读取 186 条延迟账户用量记录，选定 Workers/D1 条目报告成本为零，但最终增量账单未核验，预算预留不是实付费用。包含失败操作的精确 HTTP/管理 API/D1 计数见 [机器结果](C02-images-sse-host-expiry-tail-v2-staging-results.json)，不将 Worker binding 内部工作推导成零。

下一项先完成操作器单调时钟与开放入口前的完整 journal 校验，避免继续消耗云请求来发现操作侧错误；随后推进客户 intent-only/unknown/幂等与完整 SSE 生命周期。跨消费者物理容量、C02.G、C03–C20 保持开放。
